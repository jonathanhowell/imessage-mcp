import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { join } from "node:path";
import { createFixtureHome } from "../../imessage/test/fixtures.ts";
import { connect } from "./harness.ts";

// 1x1 PNG.
const PNG = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

const setup = async () => {
  const tmp = await Deno.makeTempDir();
  const { home } = await createFixtureHome([
    {
      guid: "photo",
      body: "parking instructions",
      handle: "+15550001",
      attachments: [
        {
          guid: "a-heic",
          filename: "~/Library/Messages/Attachments/aa/IMG_0001.HEIC",
          mime_type: "image/heic",
          transfer_name: "IMG_0001.HEIC",
          total_bytes: 1000,
        },
        {
          guid: "a-pdf",
          filename: "~/Library/Messages/Attachments/bb/plan.pdf",
          mime_type: "application/pdf",
          transfer_name: "plan.pdf",
          total_bytes: 9,
        },
      ],
    },
    {
      guid: "offloaded",
      handle: "+15550001",
      attachments: [{
        guid: "a-icloud",
        filename: "~/Library/Messages/Attachments/cc/gone.jpg",
        mime_type: "image/jpeg",
        transfer_state: 0,
      }],
    },
    {
      guid: "deleted",
      handle: "+15550001",
      attachments: [{
        guid: "a-missing",
        filename: "~/Library/Messages/Attachments/dd/lost.jpg",
        mime_type: "image/jpeg",
        transfer_state: 5,
      }],
    },
    { guid: "plain", text: "no files here", handle: "+15550001" },
  ]);
  const dir = join(home, "Library", "Messages", "Attachments");
  await Deno.mkdir(join(dir, "aa"), { recursive: true });
  await Deno.mkdir(join(dir, "bb"));
  Deno.writeFileSync(
    join(dir, "bb", "plan.pdf"),
    new TextEncoder().encode("%PDF-1.4\n"),
  );
  // Real HEIC via sips, so the conversion path is exercised.
  const png = join(tmp, "in.png");
  Deno.writeFileSync(png, PNG);
  const heic = await new Deno.Command("/usr/bin/sips", {
    args: [
      "-s",
      "format",
      "heic",
      png,
      "--out",
      join(dir, "aa", "IMG_0001.HEIC"),
    ],
    stdout: "null",
    stderr: "null",
  }).output();
  const server = await connect({ HOME: home, TMPDIR: tmp });
  return {
    server,
    heicSupported: heic.success,
    mediaDir: join(tmp, "imessage-mcp", "media"),
    async cleanup() {
      await server.close();
      await Deno.remove(home, { recursive: true });
      await Deno.remove(tmp, { recursive: true });
    },
  };
};

Deno.test("message results list their attachments", async () => {
  const t = await setup();
  try {
    const { json } = await t.server.call("get_recent_messages");
    const byGuid = Object.fromEntries(
      json.data.map((m: { guid: string }) => [m.guid, m]),
    );
    assertEquals(byGuid.plain.attachments, []);
    assertEquals(
      byGuid.photo.attachments.map((a: { filename: string }) => a.filename),
      ["IMG_0001.HEIC", "plan.pdf"],
    );
    const [heic] = byGuid.photo.attachments;
    assertEquals(heic.mime_type, "image/heic");
    assertEquals(heic.byte_size, 1000);
    assert(typeof heic.attachment_id === "number");
    // Also in search results.
    const search = await t.server.call("search_messages", { query: "parking" });
    assertEquals(search.json.data[0].attachments.length, 2);
  } finally {
    await t.cleanup();
  }
});

Deno.test("get_attachment copies the file to the media dir", async () => {
  const t = await setup();
  try {
    const result = await t.server.call("get_attachment", {
      message_guid: "photo",
    });
    assert(!result.isError, result.text);
    assertEquals(result.json.status, "ok");
    assertEquals(result.json.attachments.length, 2);

    const pdfId = result.json.attachments[1].attachment_id;
    const pdf = await t.server.call("get_attachment", { attachment_id: pdfId });
    assertEquals(pdf.json.status, "ok");
    assertEquals(pdf.json.mime_type, "application/pdf");
    assertEquals(pdf.json.filename, "plan.pdf");
    assertEquals(pdf.json.byte_size, 9);
    assertEquals(pdf.json.message_guid, "photo");
    assertStringIncludes(pdf.json.path, t.mediaDir);
    assertEquals(Deno.readTextFileSync(pdf.json.path), "%PDF-1.4\n");
    assertEquals(Deno.statSync(pdf.json.path).mode! & 0o777, 0o600);
  } finally {
    await t.cleanup();
  }
});

Deno.test("HEIC is converted to JPEG, and inline returns an image block", async () => {
  const t = await setup();
  try {
    if (!t.heicSupported) return; // sips cannot write HEIC on this machine
    const result = await t.server.call("get_attachment", {
      message_guid: "photo",
    });
    assertEquals(result.json.mime_type, "image/jpeg");
    assertEquals(result.json.converted_from, "image/heic");
    assert(result.json.path.endsWith(".jpg"));
    const bytes = Deno.readFileSync(result.json.path);
    assertEquals([bytes[0], bytes[1]], [0xff, 0xd8]); // JPEG magic

    const inline = await t.server.client.callTool({
      name: "get_attachment",
      arguments: { message_guid: "photo", inline: true },
    });
    const content = inline.content as {
      type: string;
      mimeType?: string;
      data?: string;
    }[];
    assertEquals(content.map((c) => c.type), ["text", "image"]);
    assertEquals(content[1]!.mimeType, "image/jpeg");
    assertEquals(decodeBase64(content[1]!.data!)[0], 0xff);
  } finally {
    await t.cleanup();
  }
});

Deno.test("inline non-images carry base64 data", async () => {
  const t = await setup();
  try {
    const { json } = await t.server.call("get_attachment", {
      message_guid: "photo",
    });
    const pdf = await t.server.call("get_attachment", {
      attachment_id: json.attachments[1].attachment_id,
      inline: true,
    });
    assertEquals(pdf.json.inline, true);
    assertEquals(
      new TextDecoder().decode(decodeBase64(pdf.json.data)),
      "%PDF-1.4\n",
    );
  } finally {
    await t.cleanup();
  }
});

Deno.test("get_attachment statuses for absent files", async () => {
  const t = await setup();
  try {
    const icloud = await t.server.call("get_attachment", {
      message_guid: "offloaded",
    });
    assertEquals(icloud.json.status, "not_downloaded");
    assertStringIncludes(icloud.json.note, "not on this Mac");

    const missing = await t.server.call("get_attachment", {
      message_guid: "deleted",
    });
    assertEquals(missing.json.status, "missing");

    const none = await t.server.call("get_attachment", {
      message_guid: "plain",
    });
    assertEquals(none.json.status, "no_attachment");

    const unknown = await t.server.call("get_attachment", {
      attachment_id: 99999,
    });
    assertEquals(unknown.json.status, "not_found");

    const neither = await t.server.call("get_attachment", {});
    assert(neither.isError);
  } finally {
    await t.cleanup();
  }
});
