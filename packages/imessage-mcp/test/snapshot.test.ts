import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { Database } from "@db/sqlite";
import { join } from "node:path";
import {
  createMessagesFixture,
  insertMessages,
} from "../../imessage/test/fixtures.ts";
import {
  cleanStaleSnapshots,
  createSnapshot,
  LATEST_LINK,
  readLatestTarget,
  removeOwnSnapshot,
  snapshotPathFor,
} from "../src/snapshot.ts";
import {
  createMessagesState,
  isUnavailableError,
  type MessagesConfig,
} from "../src/state.ts";
import { connect } from "./harness.ts";

const exists = (path: string) => {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const count = (path: string): number => {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare("SELECT COUNT(*) FROM message").value<[number]>()![0];
  } finally {
    db.close();
  }
};

/** A WAL-mode source whose last rows exist only in chat.db-wal. */
const walSource = async () => {
  const dir = await Deno.makeTempDir();
  const source = join(dir, "chat.db");
  createMessagesFixture(source, [{ guid: "old", text: "checkpointed" }], {
    wal: true,
  });
  const writer = new Database(source);
  writer.exec("PRAGMA wal_autocheckpoint = 0");
  insertMessages(writer, [
    { guid: "new1", text: "only in the WAL" },
    { guid: "new2", text: "also only in the WAL" },
  ]);
  return { dir, source, writer };
};

/** A PID that is certainly not running. */
const deadPid = async () => {
  const child = new Deno.Command("/usr/bin/true").spawn();
  await child.status;
  return child.pid;
};

Deno.test("snapshot includes rows that exist only in the WAL", async () => {
  const { dir, source, writer } = await walSource();
  try {
    // A plain file copy misses them: this is the failure being guarded against.
    const plainCopy = join(dir, "plain-copy.db");
    Deno.copyFileSync(source, plainCopy);
    assertEquals(count(plainCopy), 1);

    const snapDir = join(dir, "snaps");
    const result = await createSnapshot(source, {
      dir: snapDir,
      timeoutMs: 30_000,
    });
    assertEquals(result.method, "backup");
    assertEquals(result.path, snapshotPathFor(snapDir, Deno.pid));
    assertEquals(count(result.path), 3);
    assertEquals(Deno.statSync(result.path).mode! & 0o777, 0o600);

    // Self-contained file, atomically promoted, and published as latest.
    assertFalse(exists(`${result.path}-wal`));
    assertFalse(exists(`${result.path}.tmp`));
    const snap = new Database(result.path, { readonly: true });
    assertEquals(
      snap.prepare("PRAGMA journal_mode").value<[string]>()![0],
      "delete",
    );
    snap.close();
    assertEquals(
      Deno.readLinkSync(join(snapDir, LATEST_LINK)),
      "snapshot-" + Deno.pid + ".sqlite",
    );
    assertEquals(readLatestTarget(snapDir), result.path);
  } finally {
    writer.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("snapshot completes while another process writes continuously", async () => {
  const dir = await Deno.makeTempDir();
  const source = join(dir, "chat.db");
  createMessagesFixture(source, [], { wal: true });
  // Make the copy take long enough for many writes to land during it.
  const db = new Database(source);
  db.exec("CREATE TABLE padding (b BLOB)");
  const insert = db.prepare("INSERT INTO padding VALUES (randomblob(4096))");
  db.transaction(() => {
    for (let i = 0; i < 10_000; i++) insert.run();
  })();
  db.close();

  const writerScript = join(dir, "writer.ts");
  Deno.writeTextFileSync(
    writerScript,
    `import { Database } from "jsr:@db/sqlite@0.13.0";
     const db = new Database(${JSON.stringify(source)});
     db.exec("PRAGMA busy_timeout = 1000");
     for (let i = 0; ; i++) {
       db.exec("INSERT INTO message (guid, text) VALUES (?, 'w')", "w" + i);
       if (i === 0) console.log("started");
     }`,
  );
  const writer = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--allow-all",
      "--no-config",
      writerScript,
    ],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = writer.stdout.getReader();
  await reader.read(); // writer is running
  try {
    const result = await createSnapshot(source, {
      dir: join(dir, "snaps"),
      timeoutMs: 30_000,
    });
    assert(count(result.path) > 0);
  } finally {
    writer.kill("SIGKILL");
    await writer.status;
    reader.releaseLock();
    await writer.stdout.cancel();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("snapshot reports a deadline instead of hanging", async () => {
  const { dir, source, writer } = await walSource();
  try {
    await assertRejects(
      () => createSnapshot(source, { dir: join(dir, "s"), timeoutMs: 1 }),
      Error,
      "deadline",
    );
    assertFalse(exists(join(dir, "s", `snapshot-${Deno.pid}.sqlite.tmp`)));
  } finally {
    writer.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("only dead owners' snapshots are cleaned up, never latest", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const dead1 = await deadPid();
    const dead2 = await deadPid();
    const files = [
      `snapshot-${Deno.pid}.sqlite`, // live: kept
      `snapshot-${dead1}.sqlite`, // dead: removed
      `snapshot-${dead1}.sqlite.tmp`, // dead tmp: removed
      `snapshot-${dead2}.sqlite`, // dead but latest: kept
      "unrelated.sqlite", // not ours: kept
    ];
    for (const f of files) Deno.writeTextFileSync(join(dir, f), "");
    Deno.symlinkSync(`snapshot-${dead2}.sqlite`, join(dir, LATEST_LINK));

    const removed = cleanStaleSnapshots(dir).sort();
    assertEquals(removed, [
      `snapshot-${dead1}.sqlite`,
      `snapshot-${dead1}.sqlite.tmp`,
    ]);
    assert(exists(join(dir, `snapshot-${Deno.pid}.sqlite`)));
    assert(exists(join(dir, `snapshot-${dead2}.sqlite`)));
    assert(exists(join(dir, "unrelated.sqlite")));

    // Our own file goes on exit unless it is the latest.
    removeOwnSnapshot(dir);
    assertFalse(exists(join(dir, `snapshot-${Deno.pid}.sqlite`)));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const snapshotConfig = (
  path: string,
  dir: string,
  acquireWaitMs = 10_000,
): MessagesConfig => ({
  mode: "snapshot",
  path,
  snapshotDir: dir,
  snapshotTimeoutMs: 30_000,
  acquireWaitMs,
});

Deno.test("tools see snapshot_pending while the snapshot is being built", async () => {
  const { dir, source, writer } = await walSource();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const state = createMessagesState(
    snapshotConfig(source, join(dir, "s"), 50),
    () => {},
    async (path, opts) => {
      await gate;
      return createSnapshot(path, opts);
    },
  );
  try {
    void state.start();
    const error = await state.acquire().catch((e) => e);
    assert(isUnavailableError(error));
    assertEquals(error.unavailable.status, "snapshot_pending");

    release();
    await state.start(); // the build already in flight
    const db = await state.acquire();
    assertEquals(
      db.prepare("SELECT COUNT(*) FROM message").value<[number]>()![0],
      3,
    );
  } finally {
    release();
    state.close();
    writer.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failed snapshot reports snapshot_failed; a failed refresh keeps the old one", async () => {
  const dir = await Deno.makeTempDir();
  const missing = join(dir, "missing.db");
  const failing = createMessagesState(
    snapshotConfig(missing, join(dir, "s")),
    () => {},
  );
  const error = await failing.acquire().catch((e) => e);
  assert(isUnavailableError(error));
  assertEquals(error.unavailable.status, "snapshot_failed");
  assertStringIncludes(error.unavailable.message, `cannot open ${missing}`);
  failing.close();

  const source = join(dir, "chat.db");
  createMessagesFixture(source, [{ guid: "a", text: "x" }]);
  let fail = false;
  const state = createMessagesState(
    snapshotConfig(source, join(dir, "s2")),
    () => {},
    (path, opts) =>
      fail
        ? Promise.reject(new Error("disk full"))
        : createSnapshot(path, opts),
  );
  try {
    await state.acquire();
    const first = state.info()!;
    fail = true;
    const refreshError = await state.refresh().catch((e) => e);
    assert(isUnavailableError(refreshError));
    assertEquals(refreshError.unavailable.status, "snapshot_failed");
    assertEquals(refreshError.unavailable.still_serving, first);
    // Still answering from the previous snapshot.
    await state.acquire();
  } finally {
    state.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("refresh_database: snapshot mode serves a copy until refreshed", async () => {
  const dir = await Deno.makeTempDir();
  const source = join(dir, "chat.db");
  const snapDir = join(dir, "snaps");
  createMessagesFixture(source, [{ guid: "a", text: "first" }], { wal: true });
  const server = await connect({
    HOME: dir,
    IMESSAGE_DB_PATH: source,
    IMESSAGE_DB_MODE: "snapshot",
    IMESSAGE_SNAPSHOT_DIR: snapDir,
  });
  try {
    const before = await server.call("get_recent_messages");
    assert(!before.isError, before.text);
    assertEquals(before.json.pagination.total, 1);

    const db = new Database(source);
    insertMessages(db, [{ guid: "b", text: "second" }]);
    db.close();

    const stale = await server.call("get_recent_messages");
    assertEquals(stale.json.pagination.total, 1);

    const refreshed = await server.call("refresh_database");
    assert(!refreshed.isError, refreshed.text);
    assertEquals(refreshed.json.status, "ok");
    assertEquals(refreshed.json.mode, "snapshot");
    assertEquals(refreshed.json.source_path, source);
    assertEquals(
      refreshed.json.snapshot.latest_link,
      join(snapDir, LATEST_LINK),
    );

    const after = await server.call("get_recent_messages");
    assertEquals(after.json.pagination.total, 2);
  } finally {
    await server.close();
  }
  // Exiting removes nothing that latest.sqlite points at.
  assert(readLatestTarget(snapDir));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("refresh_database: live mode reopens, picking up a replaced file", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "snapshot.sqlite");
  createMessagesFixture(path, [{ guid: "a", text: "old" }]);
  const server = await connect({ HOME: dir, IMESSAGE_DB_PATH: path });
  try {
    assertEquals(
      (await server.call("get_recent_messages")).json.pagination.total,
      1,
    );
    // Replace the file the way a snapshot writer would (new inode).
    const next = join(dir, "next.sqlite");
    createMessagesFixture(next, [
      { guid: "a", text: "old" },
      { guid: "b", text: "new" },
    ]);
    Deno.renameSync(next, path);

    const refreshed = await server.call("refresh_database");
    assertEquals(refreshed.json.status, "ok");
    assertEquals(refreshed.json.mode, "live");
    assertEquals(refreshed.json.path, path);
    assertEquals(
      (await server.call("get_recent_messages")).json.pagination.total,
      2,
    );
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});
