import { assertEquals } from "@std/assert";
import { homedir } from "node:os";
import { join } from "node:path";
import { getImessageDbPath } from "../mod.ts";

const withEnv = (value: string | undefined, fn: () => void) => {
  const previous = Deno.env.get("IMESSAGE_DB_PATH");
  if (value === undefined) Deno.env.delete("IMESSAGE_DB_PATH");
  else Deno.env.set("IMESSAGE_DB_PATH", value);
  try {
    fn();
  } finally {
    if (previous === undefined) Deno.env.delete("IMESSAGE_DB_PATH");
    else Deno.env.set("IMESSAGE_DB_PATH", previous);
  }
};

const DEFAULT = join(homedir(), "Library", "Messages", "chat.db");

Deno.test("getImessageDbPath defaults to ~/Library/Messages/chat.db", () => {
  withEnv(undefined, () => assertEquals(getImessageDbPath(), DEFAULT));
});

Deno.test("getImessageDbPath ignores an empty IMESSAGE_DB_PATH", () => {
  withEnv("", () => assertEquals(getImessageDbPath(), DEFAULT));
  withEnv("  ", () => assertEquals(getImessageDbPath(), DEFAULT));
});

Deno.test("getImessageDbPath honours IMESSAGE_DB_PATH", () => {
  withEnv(
    "/tmp/snap.sqlite",
    () => assertEquals(getImessageDbPath(), "/tmp/snap.sqlite"),
  );
  withEnv(
    "~/snap.sqlite",
    () => assertEquals(getImessageDbPath(), join(homedir(), "snap.sqlite")),
  );
});
