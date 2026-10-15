import { Database } from "@db/sqlite";
import type {
  Chat,
  Handle,
  MessageWithHandle,
  PaginatedResult,
  SearchOptions,
} from "./types.ts";
import { getAttachmentSummaries } from "./attachments.ts";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Converts an Apple timestamp (nanoseconds since 2001-01-01) to a JavaScript timestamp
 * @param appleTimestamp - Timestamp in Apple's format (nanoseconds since 2001-01-01)
 * @returns JavaScript timestamp (milliseconds since 1970-01-01)
 */
export const convertAppleTimestamp = (appleTimestamp: number): number => {
  // 978307200 is the number of seconds between 1970-01-01 and 2001-01-01
  return appleTimestamp / 1000000000 + 978307200;
};

const NSSTRING = new TextEncoder().encode("NSString");
const utf8 = new TextDecoder("utf-8", { fatal: false });

const indexOf = (haystack: Uint8Array, needle: Uint8Array): number => {
  const last = haystack.length - needle.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
};

/**
 * Reads the NSString out of an archived (typedstream) NSAttributedString.
 *
 * After the `NSString` class name come a few class-version bytes, then `+`
 * (0x2B), then the byte length as a typedstream integer, then the UTF-8
 * bytes. The length is a single byte below 0x80, or 0x81 followed by a
 * 16-bit little-endian value, or 0x82 followed by a 32-bit one. (Slicing at
 * fixed offsets instead is what left a stray length byte or U+FFFD at the
 * start of some bodies.)
 * @returns The string, or `null` if the blob does not have this layout
 */
const readTypedStreamString = (blob: Uint8Array): string | null => {
  const classAt = indexOf(blob, NSSTRING);
  if (classAt < 0) return null;
  const searchFrom = classAt + NSSTRING.length;
  let i = blob.indexOf(0x2b, searchFrom);
  if (i < 0 || i - searchFrom > 8) return null;
  i++;

  const tag = blob[i];
  let length: number;
  if (tag === undefined) return null;
  if (tag < 0x80) {
    length = tag;
    i += 1;
  } else if (tag === 0x81 && i + 3 <= blob.length) {
    length = blob[i + 1]! | (blob[i + 2]! << 8);
    i += 3;
  } else if (tag === 0x82 && i + 5 <= blob.length) {
    length = (blob[i + 1]! | (blob[i + 2]! << 8) | (blob[i + 3]! << 16) |
      (blob[i + 4]! << 24)) >>> 0;
    i += 5;
  } else {
    return null;
  }
  if (i + length > blob.length) return null;
  return utf8.decode(blob.subarray(i, i + length));
};

/** Previous heuristic, kept as a fallback for blobs with another layout. */
const decodeAttributedBodyHeuristically = (blob: Uint8Array): string => {
  let attributedBody = utf8.decode(blob);
  if (attributedBody.includes("NSNumber")) {
    attributedBody = attributedBody.split("NSNumber")[0]!;
  }
  if (attributedBody.includes("NSString")) {
    attributedBody = attributedBody.split("NSString")[1]!;
  }
  if (attributedBody.includes("NSDictionary")) {
    attributedBody = attributedBody.split("NSDictionary")[0]!;
  }
  if (attributedBody.length > 18) {
    attributedBody = attributedBody.slice(6, -12);
  }
  return attributedBody
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * Decodes the message text from the `attributedBody` column (an archived
 * NSAttributedString). The result is the exact string, as the `text` column
 * would hold it, including line breaks.
 * @param attributedBodyBlob - Binary data containing NSAttributedString
 * @returns Extracted plain text string
 */
export const decodeAttributedBody = (
  attributedBodyBlob: Uint8Array | null,
): string => {
  if (!attributedBodyBlob) return "";

  try {
    return readTypedStreamString(attributedBodyBlob) ??
      decodeAttributedBodyHeuristically(attributedBodyBlob);
  } catch (error) {
    console.warn("Failed to decode attributedBody:", error);
    return "";
  }
};

/**
 * The body shown for a message: the `text` column when it is non-empty,
 * otherwise the text decoded from `attributedBody`. Modern macOS often leaves
 * `text` NULL and stores the body only in `attributedBody`.
 */
const messageBody = (
  text: string | undefined,
  attributedBody: Uint8Array | null | undefined,
): string | undefined =>
  !text && attributedBody ? decodeAttributedBody(attributedBody) : text;

/** Databases on which {@link MESSAGE_BODY_SQL}'s function is registered. */
const bodyFunctionRegistered = new WeakSet<Database>();

/**
 * SQL for a message's body, matching {@link messageBody}. `CASE` evaluates
 * lazily, so only rows without `text` call into the decoder.
 */
const MESSAGE_BODY_SQL = `CASE
  WHEN m.text IS NOT NULL AND m.text != '' THEN m.text
  WHEN length(m.attributedBody) > 0 THEN imessage_decode_body(m.attributedBody)
  ELSE m.text
END`;

const registerBodyFunction = (db: Database): void => {
  if (bodyFunctionRegistered.has(db)) return;
  db.function(
    "imessage_decode_body",
    (blob: Uint8Array | null) => blob ? decodeAttributedBody(blob) : null,
    { deterministic: true },
  );
  bodyFunctionRegistered.add(db);
};

/**
 * Finishes raw message rows: decodes bodies and attaches attachment
 * summaries (looked up only for messages flagged as having attachments).
 */
const toMessages = (
  messagesDatabase: Database,
  rows: (MessageWithHandle & {
    message_rowid: number;
    attributedBody?: Uint8Array | null;
  })[],
): MessageWithHandle[] => {
  const attachments = getAttachmentSummaries(
    messagesDatabase,
    rows.filter((r) => r.cache_has_attachments).map((r) => r.message_rowid),
  );
  return rows.map(({ attributedBody, message_rowid, ...message }) => ({
    ...message,
    text: messageBody(message.text, attributedBody),
    attachments: attachments.get(message_rowid) ?? [],
  }));
};

/**
 * Reads an environment variable only if Deno already allows it, so a
 * narrower `--allow-env=...` grant neither prompts nor throws.
 * @returns The value, or `undefined` if unset or not permitted
 */
export const readEnv = (name: string): string | undefined =>
  Deno.permissions.querySync({ name: "env", variable: name }).state ===
      "granted"
    ? Deno.env.get(name)
    : undefined;

/**
 * Returns the path of the Messages database that will be opened: the
 * `IMESSAGE_DB_PATH` environment variable when it is set, non-empty and
 * readable under the granted permissions (a leading `~/` is expanded),
 * otherwise `~/Library/Messages/chat.db`.
 * @returns Path of the database file
 */
export const getImessageDbPath = (): string => {
  const override = readEnv("IMESSAGE_DB_PATH")?.trim();
  if (override) {
    return override === "~" || override.startsWith("~/")
      ? join(homedir(), override.slice(1))
      : override;
  }
  return join(homedir(), "Library", "Messages", "chat.db");
};

/**
 * Opens a read-only connection to the macOS Messages database.
 * @param dbPath - Database file to open (default: {@link getImessageDbPath})
 * @returns Database instance for executing queries
 */
export const openMessagesDatabase = (
  dbPath: string = getImessageDbPath(),
): Database => {
  return new Database(dbPath, { readonly: true });
};

const createPaginationMetadata = (
  total: number,
  limit: number,
  offset: number,
) => {
  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  const hasMore = offset + limit < total;

  return {
    total,
    limit,
    offset,
    hasMore,
    page,
    totalPages,
  };
};

/**
 * Searches for messages with optional filtering by query text, contact handle, and date range.
 * @param messagesDatabase - Database connection to use
 * @param options - Search and filter options
 * @returns Paginated results with message data and metadata
 */
export const searchMessages = (
  messagesDatabase: Database,
  options: SearchOptions = {},
): PaginatedResult<MessageWithHandle> => {
  const {
    query,
    handle,
    startDate,
    endDate,
    limit = 100,
    offset = 0,
  } = options;

  let whereClause = "WHERE 1=1";
  const params: (string | number)[] = [];

  if (query) {
    // Match the same body that is returned, not just the raw `text` column.
    registerBodyFunction(messagesDatabase);
    whereClause += ` AND (${MESSAGE_BODY_SQL}) LIKE ?`;
    params.push(`%${query}%`);
  }

  if (handle) {
    whereClause += " AND h.id = ?";
    params.push(handle);
  }

  if (startDate) {
    const appleTimestamp = startDate.getTime() / 1000 - 978307200;
    whereClause += " AND m.date >= ?";
    params.push(appleTimestamp * 1000000000);
  }

  if (endDate) {
    const appleTimestamp = endDate.getTime() / 1000 - 978307200;
    whereClause += " AND m.date <= ?";
    params.push(appleTimestamp * 1000000000);
  }

  // Count total results
  const countSql = `
    SELECT COUNT(*) as total
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    ${whereClause}
  `;
  const countStmt = messagesDatabase.prepare(countSql);
  const { total } = countStmt.get(...params) as { total: number };

  // Get paginated data
  const dataSql = `
    SELECT
      m.ROWID AS message_rowid,
      m.guid,
      m.text,
      m.attributedBody,
      m.handle_id,
      m.service,
      m.date/1000000000 + 978307200 as date,
      m.date_read/1000000000 + 978307200 as date_read,
      m.date_delivered/1000000000 + 978307200 as date_delivered,
      m.is_from_me,
      m.is_read,
      m.is_sent,
      m.is_delivered,
      m.cache_has_attachments,
      m.thread_originator_guid as reply_to_guid,
      h.id as handle_id_string,
      h.country as handle_country,
      h.service as handle_service
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    ${whereClause}
    ORDER BY m.date DESC LIMIT ? OFFSET ?
  `;

  const dataStmt = messagesDatabase.prepare(dataSql);
  interface RawMessageRow extends MessageWithHandle {
    message_rowid: number;
    attributedBody?: Uint8Array | null;
  }
  const rawData = dataStmt.all(...params, limit, offset) as RawMessageRow[];

  const data = toMessages(messagesDatabase, rawData);

  return {
    data,
    pagination: createPaginationMetadata(total, limit, offset),
  };
};

/**
 * Gets the most recent messages across all conversations.
 * @param messagesDatabase - Database connection to use
 * @param limit - Maximum number of messages to return (default: 20)
 * @param offset - Number of messages to skip for pagination (default: 0)
 * @returns Paginated results with recent messages ordered by date
 */
export const getRecentMessages = (
  messagesDatabase: Database,
  limit = 20,
  offset = 0,
): PaginatedResult<MessageWithHandle> => {
  return searchMessages(messagesDatabase, { limit, offset });
};

/**
 * Gets all chat conversations ordered by most recent activity.
 * @param messagesDatabase - Database connection to use
 * @param limit - Maximum number of chats to return (default: 50)
 * @param offset - Number of chats to skip for pagination (default: 0)
 * @returns Paginated results with chat data and metadata
 */
export const getChats = (
  messagesDatabase: Database,
  limit = 50,
  offset = 0,
): PaginatedResult<Chat> => {
  // Count total chats
  const countSql = "SELECT COUNT(*) as total FROM chat";
  const countStmt = messagesDatabase.prepare(countSql);
  const { total } = countStmt.get() as { total: number };

  // Get paginated data
  const dataSql = `
    SELECT 
      c.ROWID,
      c.guid,
      c.style,
      c.state,
      c.account_id,
      c.chat_identifier,
      c.service_name,
      c.room_name,
      c.display_name,
      c.last_read_message_timestamp
    FROM chat c
    ORDER BY c.last_read_message_timestamp DESC
    LIMIT ? OFFSET ?
  `;

  const dataStmt = messagesDatabase.prepare(dataSql);
  const data = dataStmt.all(limit, offset) as Chat[];

  return {
    data,
    pagination: createPaginationMetadata(total, limit, offset),
  };
};

/**
 * Gets all contact handles (phone numbers and email addresses) from the database.
 * @param messagesDatabase - Database connection to use
 * @param limit - Maximum number of handles to return (default: 100)
 * @param offset - Number of handles to skip for pagination (default: 0)
 * @returns Paginated results with handle data and metadata
 */
export const getHandles = (
  messagesDatabase: Database,
  limit = 100,
  offset = 0,
): PaginatedResult<Handle> => {
  // Count total handles
  const countSql = "SELECT COUNT(*) as total FROM handle";
  const countStmt = messagesDatabase.prepare(countSql);
  const { total } = countStmt.get() as { total: number };

  // Get paginated data
  const dataSql = `
    SELECT 
      ROWID,
      id,
      country,
      service,
      uncanonicalized_id
    FROM handle
    ORDER BY id
    LIMIT ? OFFSET ?
  `;

  const dataStmt = messagesDatabase.prepare(dataSql);
  const data = dataStmt.all(limit, offset) as Handle[];

  return {
    data,
    pagination: createPaginationMetadata(total, limit, offset),
  };
};

/**
 * Gets messages from a specific chat conversation identified by its GUID.
 * @param messagesDatabase - Database connection to use
 * @param chatGuid - Unique identifier of the chat
 * @param limit - Maximum number of messages to return (default: 50)
 * @param offset - Number of messages to skip for pagination (default: 0)
 * @returns Paginated results with messages from the specified chat
 */
export const getMessagesFromChat = (
  messagesDatabase: Database,
  chatGuid: string,
  limit = 50,
  offset = 0,
): PaginatedResult<MessageWithHandle> => {
  // Count total messages in chat
  const countSql = `
    SELECT COUNT(*) as total
    FROM message m
    JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    JOIN chat c ON cmj.chat_id = c.ROWID
    WHERE c.guid = ?
  `;
  const countStmt = messagesDatabase.prepare(countSql);
  const { total } = countStmt.get(chatGuid) as { total: number };

  // Get paginated data
  const dataSql = `
    SELECT
      m.ROWID AS message_rowid,
      m.guid,
      m.text,
      m.attributedBody,
      m.handle_id,
      m.service,
      m.date/1000000000 + 978307200 as date,
      m.date_read/1000000000 + 978307200 as date_read,
      m.date_delivered/1000000000 + 978307200 as date_delivered,
      m.is_from_me,
      m.is_read,
      m.is_sent,
      m.is_delivered,
      m.cache_has_attachments,
      m.thread_originator_guid as reply_to_guid,
      h.id as handle_id_string,
      h.country as handle_country,
      h.service as handle_service
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    JOIN chat c ON cmj.chat_id = c.ROWID
    WHERE c.guid = ?
    ORDER BY m.date DESC
    LIMIT ? OFFSET ?
  `;

  const dataStmt = messagesDatabase.prepare(dataSql);
  interface RawMessageRow extends MessageWithHandle {
    message_rowid: number;
    attributedBody?: Uint8Array | null;
  }
  const rawData = dataStmt.all(chatGuid, limit, offset) as RawMessageRow[];

  const data = toMessages(messagesDatabase, rawData);

  return {
    data,
    pagination: createPaginationMetadata(total, limit, offset),
  };
};
