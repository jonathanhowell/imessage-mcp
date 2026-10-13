import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { createFixtureHome } from "../../imessage/test/fixtures.ts";
import { connect, MOD_PATH, SERVER_FLAGS, serverEnv } from "./harness.ts";

const TOOLS = [
  "get_chats",
  "get_handles",
  "get_messages_from_chat",
  "get_recent_messages",
  "search_contacts",
  "search_messages",
];

Deno.test("handshake succeeds and tools report db_unavailable when chat.db cannot be opened", async () => {
  const { home, dbPath } = await createFixtureHome();
  // An unreadable file reproduces what a missing Full Disk Access grant does:
  // the file exists but SQLite cannot open it (SqliteError 14).
  await Deno.chmod(dbPath, 0o000);
  const server = await connect({ HOME: home });
  try {
    const { tools } = await server.client.listTools();
    for (const name of TOOLS) {
      assert(tools.some((t) => t.name === name), `missing tool ${name}`);
    }

    const result = await server.call("search_messages", { query: "x" });
    assert(result.isError);
    assertEquals(result.json.status, "db_unavailable");
    assertEquals(result.json.path, dbPath);
    assertStringIncludes(result.json.message, `cannot open ${dbPath}`);
    assertStringIncludes(result.json.message, "SqliteError 14");
    assertStringIncludes(result.json.message, "Full Disk Access");
    assertStringIncludes(result.json.message, Deno.execPath());

    // Still alive and answering after the failure.
    const again = await server.call("get_handles");
    assertEquals(again.json.status, "db_unavailable");
  } finally {
    await server.close();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("a missing chat.db is reported as not existing", async () => {
  const home = await Deno.makeTempDir();
  const server = await connect({ HOME: home });
  try {
    const result = await server.call("get_chats");
    assertEquals(result.json.status, "db_unavailable");
    assertStringIncludes(result.json.message, "does not exist");
  } finally {
    await server.close();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("contacts failure does not take down message tools", async () => {
  const { home } = await createFixtureHome([
    { guid: "m1", text: "hello", handle: "+15550001" },
  ]);
  // No AddressBook directory at all.
  const server = await connect({ HOME: home });
  try {
    const contacts = await server.call("search_contacts", {
      firstName: "Ann",
    });
    assert(contacts.isError);
    assertEquals(contacts.json.status, "contacts_unavailable");
    assertStringIncludes(
      contacts.json.message,
      join(home, "Library", "Application Support", "AddressBook", "Sources"),
    );

    const handles = await server.call("get_handles");
    assert(!handles.isError);
    assertEquals(handles.json.data[0].id, "+15550001");
  } finally {
    await server.close();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("server exits cleanly when stdin closes", async () => {
  const home = await Deno.makeTempDir();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", ...SERVER_FLAGS, MOD_PATH],
    env: serverEnv({ HOME: home }),
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    await child.stdin.close();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const status = await child.status;
    clearTimeout(timeout);
    assertEquals(status.code, 0);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
