// The server must not keep the Messages database open between tool calls.
// While any connection stays attached, SQLite cannot delete or reset the WAL
// when another process closes the file, so a job that refreshes a snapshot in
// place with sqlite3_backup appends a whole copy to the -wal file each run
// (77 GB on 2026-10-27).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Database } from "@db/sqlite";
import { join } from "node:path";
import { createMessagesFixture } from "../../imessage/test/fixtures.ts";
import { createMessagesState } from "../src/state.ts";
import { loadMessagesConfig } from "../src/state.ts";
import { connect } from "./harness.ts";

/** Open file handles `pid` has on `path` or its -wal/-shm files. */
const handlesOn = async (pid: number, path: string): Promise<number> => {
  const out = await new Deno.Command("/usr/sbin/lsof", {
    args: ["-p", String(pid)],
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(out.stdout).split("\n")
    .filter((line) => line.includes(path)).length;
};

const walSize = (path: string): number => {
  try {
    return Deno.statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
};

/** A WAL-mode database big enough that a leaked WAL would be obvious. */
const walDatabase = (path: string, text: string) => {
  createMessagesFixture(
    path,
    [{
      guid: "m1",
      text,
      handle: "+15550001",
      chat: "chat-1",
      attachments: [{ guid: "a1", filename: null }],
    }],
    { wal: true },
  );
  const db = new Database(path);
  db.exec("CREATE TABLE padding (b BLOB)");
  const insert = db.prepare("INSERT INTO padding VALUES (randomblob(4096))");
  db.transaction(() => {
    for (let i = 0; i < 500; i++) insert.run();
  })();
  db.close();
};

/** What the snapshot copy job does: back up the source into `dest` in place. */
const copyInPlace = (source: string, dest: string) => {
  const from = new Database(source, { readonly: true });
  const to = new Database(dest);
  try {
    from.backup(to, "main", -1);
  } finally {
    to.close();
    from.close();
  }
};

Deno.test("no connection stays open after a tool call", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "snapshot.sqlite");
  walDatabase(path, "hello");
  const server = await connect({ HOME: dir, IMESSAGE_DB_PATH: path });
  const pid = (server.client.transport as unknown as { pid: number }).pid;
  try {
    const calls: [string, Record<string, unknown>][] = [
      ["get_recent_messages", {}],
      ["search_messages", { query: "hello" }],
      ["get_chats", {}],
      ["get_handles", {}],
      ["get_messages_from_chat", { chatGuid: "chat-1" }],
      ["get_attachment", { message_guid: "m1" }],
      ["refresh_database", {}],
    ];
    for (const [tool, args] of calls) {
      const result = await server.call(tool, args);
      assert(!result.isError, `${tool}: ${result.text}`);
      assertEquals(await handlesOn(pid, path), 0, `${tool} left it open`);
    }
    // A second writer can checkpoint and truncate the WAL.
    const writer = new Database(path);
    const [busy] = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)")
      .value<[number]>()!;
    writer.close();
    assertEquals(busy, 0);
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("in-place snapshot copies do not grow the WAL, and reads stay fresh", async () => {
  const dir = await Deno.makeTempDir();
  const source = join(dir, "chat.db");
  const snapshot = join(dir, "snapshot.sqlite");
  walDatabase(source, "first");
  copyInPlace(source, snapshot);
  const server = await connect({ HOME: dir, IMESSAGE_DB_PATH: snapshot });
  try {
    for (let i = 1; i <= 4; i++) {
      const db = new Database(source);
      db.exec("INSERT INTO message (guid, text) VALUES (?, 'new')", `n${i}`);
      db.close();
      copyInPlace(source, snapshot);
      // The copy job was the last connection, so SQLite removed the WAL.
      assertEquals(walSize(snapshot), 0, `WAL left after copy ${i}`);

      const recent = await server.call("get_recent_messages");
      assertEquals(recent.json.pagination.total, 1 + i);
    }
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withDatabase closes the connection even when the call throws", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "snapshot.sqlite");
  walDatabase(path, "x");
  const previous = Deno.env.get("IMESSAGE_DB_PATH");
  Deno.env.set("IMESSAGE_DB_PATH", path);
  const state = createMessagesState(loadMessagesConfig(), () => {});
  try {
    await assertRejects(
      () =>
        state.withDatabase((db) => {
          db.prepare("SELECT * FROM message").all();
          throw new Error("boom");
        }),
      Error,
      "boom",
    );
    assertEquals(await handlesOn(Deno.pid, path), 0);
  } finally {
    state.close();
    if (previous === undefined) Deno.env.delete("IMESSAGE_DB_PATH");
    else Deno.env.set("IMESSAGE_DB_PATH", previous);
    await Deno.remove(dir, { recursive: true });
  }
});
