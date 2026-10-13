import { assertEquals } from "@std/assert";
import { decodeAttributedBody } from "../mod.ts";
import { encodeAttributedBody } from "./fixtures.ts";

const encoder = new TextEncoder();
const roundTrip = (text: string) =>
  assertEquals(decodeAttributedBody(encodeAttributedBody(text)), text);

/** A string of exactly `bytes` UTF-8 bytes. */
const ofBytes = (bytes: number, prefix = "") =>
  prefix + "x".repeat(bytes - encoder.encode(prefix).length);

Deno.test("decodes a short body", () => {
  roundTrip("Ok");
  roundTrip(ofBytes(50, "Your hire booking ")); // length byte "2"
  roundTrip(ofBytes(127));
});

Deno.test("decodes an empty body", () => roundTrip(""));

Deno.test("length bytes do not leak into the text", () => {
  // The old fixed slice left the low byte of a 0x81 length at the start of
  // the body: 306 bytes is 81 32 01, giving "2Your hire booking...", 318 is
  // 81 3e 01 (">"), and a low byte >= 0x80 (e.g. 400: 81 90 01) gave U+FFFD.
  for (const bytes of [306, 318, 400]) {
    const text = ofBytes(bytes, "Your hire booking ");
    assertEquals(decodeAttributedBody(encodeAttributedBody(text)), text);
  }
});

Deno.test("decodes a body over 127 bytes (0x81 + 16-bit length)", () => {
  const text = ofBytes(128, "Starts here. ");
  assertEquals(encodeAttributedBody(text).includes(0x81), true);
  roundTrip(text);
  roundTrip(ofBytes(200, "Starts here. "));
});

Deno.test("decodes a body over 255 bytes", () => {
  roundTrip(ofBytes(256, "Starts here. "));
  roundTrip(ofBytes(4000, "Starts here. "));
});

Deno.test("decodes a body over 65535 bytes (0x82 + 32-bit length)", () => {
  roundTrip(ofBytes(70_000, "Starts here. "));
});

Deno.test("decodes emoji and other multi-byte UTF-8", () => {
  roundTrip("👍");
  roundTrip("Running late 🚗💨 — see you at 7 ✅");
  // Over 127 bytes but fewer than 128 UTF-16 units: length is in bytes.
  const emoji = "😀".repeat(40);
  assertEquals(encoder.encode(emoji).length, 160);
  roundTrip(emoji);
});

Deno.test("keeps line breaks and spacing as the text column would", () => {
  roundTrip("Line one\nLine two\n\n  indented");
});

Deno.test("returns an empty string for null", () => {
  assertEquals(decodeAttributedBody(null), "");
});

Deno.test("falls back to the heuristic for an unrecognised layout", () => {
  const blob = encoder.encode(
    "xxxxNSString\u0001\u0001\u0001\u0001\u0001\u0001hello there friend this is text1234567890NSDictionary",
  );
  assertEquals(decodeAttributedBody(blob).includes("hello there"), true);
});
