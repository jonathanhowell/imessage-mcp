import type { Database } from "@db/sqlite";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Attachment, AttachmentSummary } from "./types.ts";

/** `attachment.transfer_state` once the file has been downloaded. */
const TRANSFER_FINISHED = 5;

const ATTACHMENT_COLUMNS = `
  a.ROWID AS attachment_id,
  a.guid,
  a.filename,
  a.transfer_name,
  a.mime_type,
  a.uti,
  a.total_bytes,
  a.transfer_state`;

/** Expands the leading `~` Messages stores in `attachment.filename`. */
export const expandAttachmentPath = (filename: string): string =>
  filename === "~" || filename.startsWith("~/")
    ? join(homedir(), filename.slice(1))
    : filename;

/** The name to show for an attachment: its original name where known. */
const displayName = (
  row: Pick<Attachment, "transfer_name" | "filename">,
): string | undefined =>
  row.transfer_name || (row.filename ? basename(row.filename) : undefined);

export const toAttachmentSummary = (row: Attachment): AttachmentSummary => ({
  attachment_id: row.attachment_id,
  filename: displayName(row),
  mime_type: row.mime_type ?? undefined,
  byte_size: row.total_bytes,
});

/**
 * Attachment summaries for a set of messages, keyed by message ROWID.
 * @param messagesDatabase - Database connection to use
 * @param messageIds - `message.ROWID` values
 */
export const getAttachmentSummaries = (
  messagesDatabase: Database,
  messageIds: number[],
): Map<number, AttachmentSummary[]> => {
  const byMessage = new Map<number, AttachmentSummary[]>();
  // Stay well under SQLite's bound-parameter limit.
  for (let i = 0; i < messageIds.length; i += 500) {
    const ids = messageIds.slice(i, i + 500);
    const rows = messagesDatabase.prepare(`
      SELECT maj.message_id, ${ATTACHMENT_COLUMNS}
      FROM message_attachment_join maj
      JOIN attachment a ON a.ROWID = maj.attachment_id
      WHERE maj.message_id IN (${ids.map(() => "?").join(",")})
      ORDER BY maj.message_id, a.ROWID
    `).all(...ids) as (Attachment & { message_id: number })[];
    for (const row of rows) {
      const list = byMessage.get(row.message_id) ?? [];
      list.push(toAttachmentSummary(row));
      byMessage.set(row.message_id, list);
    }
  }
  return byMessage;
};

/**
 * Looks up one attachment by its `attachment.ROWID`, with the GUID of the
 * message it belongs to.
 */
export const getAttachmentById = (
  messagesDatabase: Database,
  attachmentId: number,
): (Attachment & { message_guid: string | undefined }) | undefined =>
  messagesDatabase.prepare(`
    SELECT ${ATTACHMENT_COLUMNS}, m.guid AS message_guid
    FROM attachment a
    LEFT JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
    LEFT JOIN message m ON m.ROWID = maj.message_id
    WHERE a.ROWID = ?
    LIMIT 1
  `).get(attachmentId) as
    | (Attachment & { message_guid: string | undefined })
    | undefined;

/**
 * Lists a message's attachments.
 * @returns `undefined` if no message has this GUID, else its attachments
 */
export const getMessageAttachments = (
  messagesDatabase: Database,
  messageGuid: string,
): Attachment[] | undefined => {
  const message = messagesDatabase
    .prepare("SELECT ROWID FROM message WHERE guid = ?")
    .value<[number]>(messageGuid);
  if (!message) return undefined;
  return messagesDatabase.prepare(`
    SELECT ${ATTACHMENT_COLUMNS}
    FROM message_attachment_join maj
    JOIN attachment a ON a.ROWID = maj.attachment_id
    WHERE maj.message_id = ?
    ORDER BY a.ROWID
  `).all(message[0]) as Attachment[];
};

export type AttachmentFileStatus =
  | "ok"
  | "not_downloaded"
  | "missing"
  | "unreadable";

export interface AttachmentFile {
  status: AttachmentFileStatus;
  /** Absolute path on disk (`~` expanded), when Messages recorded one. */
  path: string | undefined;
  /** Actual size on disk when `status` is `ok`. */
  size: number | undefined;
  note?: string;
}

/**
 * Where an attachment's file is and whether it can be read.
 * - `not_downloaded`: not on this Mac, e.g. offloaded to iCloud (Messages
 *   resets `transfer_state` and may clear `filename`).
 * - `missing`: recorded as downloaded, but the file is gone.
 * - `unreadable`: present but not readable by this process, usually a
 *   missing Full Disk Access grant.
 */
export const resolveAttachmentFile = (row: Attachment): AttachmentFile => {
  if (!row.filename) {
    return { status: "not_downloaded", path: undefined, size: undefined };
  }
  const path = expandAttachmentPath(row.filename);
  let stat: Deno.FileInfo;
  try {
    stat = Deno.statSync(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return {
        status: "unreadable",
        path,
        size: undefined,
        note: `${(error as Error).name}: ${(error as Error).message}`,
      };
    }
    return {
      status: row.transfer_state === TRANSFER_FINISHED
        ? "missing"
        : "not_downloaded",
      path,
      size: undefined,
    };
  }
  if (!stat.isFile) {
    return {
      status: "missing",
      path,
      size: undefined,
      note: "The recorded path is a directory, not a file.",
    };
  }
  return { status: "ok", path, size: stat.size };
};
