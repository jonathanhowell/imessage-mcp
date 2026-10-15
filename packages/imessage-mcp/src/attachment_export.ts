import { encodeBase64 } from "@std/encoding/base64";
import { basename, extname, join } from "node:path";
import { type Attachment, resolveAttachmentFile } from "@wyattjoh/imessage";
import { userTempDir } from "./snapshot.ts";

export const INLINE_LIMIT_BYTES = 5 * 1024 * 1024;
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

/** `$TMPDIR/imessage-mcp/media`, where attachments are copied for callers. */
export const defaultMediaDir = (): string =>
  join(userTempDir(), "imessage-mcp", "media");

const HEIC_TYPES = new Set(["image/heic", "image/heif"]);
const isHeic = (mimeType: string | undefined, path: string) =>
  HEIC_TYPES.has(mimeType ?? "") ||
  [".heic", ".heif"].includes(extname(path).toLowerCase());

const EXTENSION_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".webp": "image/webp",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".m4a": "audio/x-m4a",
  ".caf": "audio/x-caf",
  ".amr": "audio/amr",
  ".vcf": "text/vcard",
  ".txt": "text/plain",
};

const mimeTypeFor = (row: Attachment, path: string): string =>
  row.mime_type || EXTENSION_TYPES[extname(path).toLowerCase()] ||
  "application/octet-stream";

/** Removes exports older than a day (any instance's). */
const prune = (dir: string): void => {
  const now = Date.now();
  for (const entry of Deno.readDirSync(dir)) {
    try {
      const path = join(dir, entry.name);
      const mtime = Deno.statSync(path).mtime?.getTime() ?? now;
      if (now - mtime > EXPORT_TTL_MS) Deno.removeSync(path);
    } catch {
      // raced with another instance
    }
  }
};

const safeName = (name: string): string =>
  name.replace(/[/\0]/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";

/** Converts with macOS `sips`; returns false if it is unavailable or fails. */
const convertToJpeg = async (from: string, to: string): Promise<boolean> => {
  try {
    const { success } = await new Deno.Command("/usr/bin/sips", {
      args: ["-s", "format", "jpeg", from, "--out", to],
      stdout: "null",
      stderr: "null",
    }).output();
    return success && Deno.statSync(to).isFile;
  } catch {
    return false;
  }
};

export type AttachmentResult =
  & {
    status:
      | "ok"
      | "no_attachment"
      | "not_downloaded"
      | "missing"
      | "unreadable";
    attachment_id: number;
    message_guid: string | undefined;
    filename: string | undefined;
    mime_type: string | undefined;
    byte_size: number | undefined;
    note?: string;
  }
  & Record<string, unknown>;

const NOTES = {
  not_downloaded:
    "The attachment is not on this Mac (for example, offloaded to iCloud). " +
    "This server is read-only and cannot download it: open the conversation " +
    "in Messages so it downloads, then call get_attachment again.",
  missing:
    "Messages recorded this attachment as downloaded, but the file is no " +
    "longer on disk.",
  unreadable:
    "The file exists but this process cannot read it. This is usually a " +
    `missing Full Disk Access grant for ${Deno.execPath()}.`,
};

/**
 * Makes an attachment available to the caller: copies it (converting HEIC
 * to JPEG where `sips` allows) into the media directory and returns the
 * path, or with `inline` returns the bytes base64-encoded.
 */
export const exportAttachment = async (
  row: Attachment & { message_guid: string | undefined },
  { inline = false, dir = defaultMediaDir() }: {
    inline?: boolean;
    dir?: string;
  } = {},
): Promise<AttachmentResult & { data?: string }> => {
  const file = resolveAttachmentFile(row);
  const base = {
    attachment_id: row.attachment_id,
    message_guid: row.message_guid,
    filename: row.transfer_name ||
      (row.filename ? basename(row.filename) : undefined),
  };
  if (file.status !== "ok") {
    return {
      ...base,
      status: file.status,
      mime_type: row.mime_type,
      byte_size: row.total_bytes,
      ...(file.path ? { source_path: file.path } : {}),
      note: [NOTES[file.status], file.note].filter(Boolean).join(" "),
    };
  }

  Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
  prune(dir);

  const source = file.path!;
  const name = safeName(base.filename ?? basename(source));
  let path = join(dir, `${row.attachment_id}-${name}`);
  let mimeType = mimeTypeFor(row, source);
  const extra: Record<string, unknown> = {};

  if (isHeic(row.mime_type, source)) {
    const jpeg = join(
      dir,
      `${row.attachment_id}-${name.replace(/\.[^.]*$/, "")}.jpg`,
    );
    const tmp = `${jpeg}.${Deno.pid}.tmp.jpg`;
    if (await convertToJpeg(source, tmp)) {
      Deno.renameSync(tmp, jpeg);
      path = jpeg;
      extra.converted_from = mimeType;
      mimeType = "image/jpeg";
    } else {
      extra.note = "HEIC to JPEG conversion with sips was not possible " +
        "(it needs --allow-run); returning the original HEIC file.";
    }
  }
  if (!extra.converted_from) {
    const tmp = `${path}.${Deno.pid}.tmp`;
    Deno.copyFileSync(source, tmp);
    Deno.renameSync(tmp, path);
  }
  Deno.chmodSync(path, 0o600);
  // The copy keeps the source's mtime; the 24 h pruning goes by export time.
  const now = new Date();
  Deno.utimeSync(path, now, now);
  const size = Deno.statSync(path).size;

  const result = {
    ...base,
    status: "ok" as const,
    path,
    mime_type: mimeType,
    byte_size: size,
    source_path: source,
    ...extra,
  };
  if (!inline) return { ...result, inline: false };
  if (size > INLINE_LIMIT_BYTES) {
    return {
      ...result,
      inline: false,
      note: [
        extra.note,
        `The file is over ${
          INLINE_LIMIT_BYTES / 1024 / 1024
        } MB, so it was not inlined; read it from \`path\`.`,
      ].filter(Boolean).join(" "),
    };
  }
  return {
    ...result,
    inline: true,
    data: encodeBase64(Deno.readFileSync(path)),
  };
};
