import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { join } from "node:path";
import { getRecentMessages, searchMessages } from "../mod.ts";
import { createMessagesFixture, type FixtureMessage } from "./fixtures.ts";

const MESSAGES: FixtureMessage[] = [
  { guid: "text-only", text: "Lunch at the Northgate cafe?", handle: "+1555" },
  // Modern macOS: text NULL, body only in attributedBody.
  {
    guid: "body-only",
    body: "Your Northgate hire booking is confirmed",
    handle: "Northgate",
  },
  {
    guid: "body-only-2",
    body: "Skoda Karoq ready for collection",
    handle: "Northgate",
  },
  {
    guid: "empty-text",
    text: "",
    body: "Parcel delivered to porch",
    handle: "+1666",
  },
  { guid: "no-body", handle: "+1666" },
];

const withFixture = async (fn: (db: Database) => void) => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "chat.db");
  createMessagesFixture(path, MESSAGES);
  const db = new Database(path, { readonly: true });
  try {
    fn(db);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
};

const guids = (db: Database, query: string, extra = {}) =>
  searchMessages(db, { query, ...extra }).data.map((m) => m.guid).sort();

Deno.test("query matches bodies stored only in attributedBody", () =>
  withFixture((db) => {
    assertEquals(guids(db, "Northgate"), ["body-only", "text-only"]);
    assertEquals(guids(db, "Karoq"), ["body-only-2"]);
    assertEquals(guids(db, "hire booking"), ["body-only"]);
    assertEquals(guids(db, "porch"), ["empty-text"]);
    // Case-insensitive like the text column match.
    assertEquals(guids(db, "skoda"), ["body-only-2"]);
    // Combined with the handle filter, and counted consistently.
    assertEquals(guids(db, "Northgate", { handle: "Northgate" }), [
      "body-only",
    ]);
    const result = searchMessages(db, { query: "Northgate", limit: 1 });
    assertEquals(result.pagination.total, 2);
    assertEquals(result.pagination.hasMore, true);
  }));

Deno.test("every word of every recent message is findable via query", () =>
  withFixture((db) => {
    for (const message of getRecentMessages(db, 100).data) {
      for (const word of message.text?.match(/[\p{L}\p{N}]{4,}/gu) ?? []) {
        const found = guids(db, word);
        assertEquals(
          found.includes(message.guid),
          true,
          `"${word}" from ${message.guid} not found (got ${found})`,
        );
      }
    }
  }));
