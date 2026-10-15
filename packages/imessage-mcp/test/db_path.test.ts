import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { createMessagesFixture } from "../../imessage/test/fixtures.ts";
import { connect } from "./harness.ts";

const NARROW_ENV =
  "IMESSAGE_DB_PATH,DENO_SQLITE_PATH,DENO_SQLITE_LOCAL,HOME,DENO_DIR,XDG_CACHE_HOME";

Deno.test("IMESSAGE_DB_PATH points the server at another database", async () => {
  const dir = await Deno.makeTempDir();
  const dbPath = join(dir, "snapshot.sqlite");
  createMessagesFixture(dbPath, [
    { guid: "m1", text: "from the snapshot", handle: "+15550002" },
  ]);
  // HOME has no chat.db, so a result proves the override was used.
  const server = await connect({ HOME: dir, IMESSAGE_DB_PATH: dbPath });
  try {
    const result = await server.call("get_recent_messages");
    assert(!result.isError, result.text);
    assertEquals(result.json.data[0].text, "from the snapshot");
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("db_unavailable names the IMESSAGE_DB_PATH it tried", async () => {
  const dir = await Deno.makeTempDir();
  const dbPath = join(dir, "missing.sqlite");
  const server = await connect({ HOME: dir, IMESSAGE_DB_PATH: dbPath });
  try {
    const result = await server.call("get_chats");
    assertEquals(result.json.status, "db_unavailable");
    assertEquals(result.json.path, dbPath);
    assertStringIncludes(result.json.message, `cannot open ${dbPath}`);
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});

// The narrow grant from the README. @db/sqlite itself needs the SQLite and
// cache variables to locate its native library (in the real cache, hence the
// real HOME here).
Deno.test("works with a narrow --allow-env grant", async () => {
  const dir = await Deno.makeTempDir();
  const dbPath = join(dir, "snapshot.sqlite");
  createMessagesFixture(dbPath, [
    { guid: "m1", text: "narrow permissions", handle: "+15550003" },
  ]);
  const server = await connect(
    {
      HOME: Deno.env.get("HOME")!,
      IMESSAGE_DB_PATH: dbPath,
      IMESSAGE_DB_MODE: "snapshot",
    },
    [
      "--allow-read",
      `--allow-env=${NARROW_ENV}`,
      "--allow-sys=homedir",
      "--allow-ffi",
    ],
  );
  try {
    // IMESSAGE_DB_MODE is not readable, so the default live mode applies.
    const refreshed = await server.call("refresh_database");
    assertEquals(refreshed.json.mode, "live");
    const result = await server.call("search_messages", { query: "narrow" });
    assert(!result.isError, result.text);
    assertEquals(result.json.data[0].guid, "m1");
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});
