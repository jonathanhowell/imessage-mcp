import { assert } from "@std/assert";
import { createFixtureHome } from "../../imessage/test/fixtures.ts";
import { connect } from "./harness.ts";

Deno.test("search_messages query finds every message get_recent_messages returns", async () => {
  const { home } = await createFixtureHome([
    { guid: "a", text: "Dinner on Friday?", handle: "+15550001" },
    {
      guid: "b",
      body: "Your Northgate hire booking is confirmed",
      handle: "Northgate",
    },
    {
      guid: "c",
      body: "Skoda Karoq ready for collection",
      handle: "Northgate",
    },
    {
      guid: "d",
      body: "😀 emoji then a distinctive word: quokka",
      handle: "+15550002",
    },
  ]);
  const server = await connect({ HOME: home });
  try {
    const recent = await server.call("get_recent_messages", { limit: 100 });
    assert(recent.json.data.length === 4);
    for (const message of recent.json.data) {
      const words: string[] = message.text.match(/[\p{L}\p{N}]{4,}/gu);
      const word = words.sort((x, y) => y.length - x.length)[0]!;
      const found = await server.call("search_messages", { query: word });
      assert(
        found.json.data.some((m: { guid: string }) => m.guid === message.guid),
        `"${word}" from ${message.guid} not found via query`,
      );
    }
  } finally {
    await server.close();
    await Deno.remove(home, { recursive: true });
  }
});
