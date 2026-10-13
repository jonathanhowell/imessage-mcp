// Test fixtures: a minimal chat.db with the columns this library reads.
import { Database } from "@db/sqlite";
import { join } from "node:path";

const SCHEMA = `
  CREATE TABLE handle (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
    country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT
  );
  CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
    text TEXT, attributedBody BLOB, handle_id INTEGER DEFAULT 0,
    service TEXT, date INTEGER, date_read INTEGER, date_delivered INTEGER,
    is_from_me INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0,
    is_sent INTEGER DEFAULT 0, is_delivered INTEGER DEFAULT 0,
    cache_has_attachments INTEGER DEFAULT 0, thread_originator_guid TEXT
  );
  CREATE TABLE chat (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
    style INTEGER, state INTEGER, account_id TEXT, chat_identifier TEXT,
    service_name TEXT, room_name TEXT, display_name TEXT,
    last_read_message_timestamp INTEGER DEFAULT 0
  );
  CREATE TABLE chat_message_join (
    chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0
  );
  CREATE TABLE attachment (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
    filename TEXT, uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0,
    transfer_name TEXT, total_bytes INTEGER DEFAULT 0
  );
  CREATE TABLE message_attachment_join (
    message_id INTEGER, attachment_id INTEGER
  );
`;

const encoder = new TextEncoder();

/** Typedstream signed-integer encoding, as used for string lengths. */
const encodeLength = (n: number): number[] => {
  if (n < 0x80) return [n];
  if (n <= 0xffff) return [0x81, n & 0xff, n >> 8];
  return [0x82, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
};

/**
 * Builds an `attributedBody` blob in the layout Messages writes: an archived
 * NSAttributedString whose NSString is stored as `+`, a typedstream length
 * and the UTF-8 bytes, followed by the attribute dictionary.
 */
export const encodeAttributedBody = (text: string): Uint8Array => {
  const body = encoder.encode(text);
  const ascii = (s: string) => Array.from(encoder.encode(s));
  return new Uint8Array([
    0x04,
    0x0b,
    ...ascii("streamtyped"),
    0x81,
    0xe8,
    0x03,
    0x84,
    0x01,
    0x40,
    0x84,
    0x84,
    0x84,
    0x12,
    ...ascii("NSAttributedString"),
    0x00,
    0x84,
    0x84,
    0x08,
    ...ascii("NSObject"),
    0x00,
    0x85,
    0x92,
    0x84,
    0x84,
    0x84,
    0x08,
    ...ascii("NSString"),
    0x01,
    0x94,
    0x84,
    0x01,
    0x2b,
    ...encodeLength(body.length),
    ...body,
    0x86,
    0x84,
    0x02,
    0x69,
    0x49,
    0x01,
    ...encodeLength(text.length),
    0x92,
    0x84,
    0x84,
    0x84,
    0x0c,
    ...ascii("NSDictionary"),
    0x00,
    0x94,
    0x84,
    0x01,
    0x69,
    0x01,
    0x92,
    0x84,
    0x96,
    0x96,
    0x1d,
    ...ascii("__kIMMessagePartAttributeName"),
    0x86,
    0x92,
    0x84,
    0x84,
    0x84,
    0x08,
    ...ascii("NSNumber"),
    0x00,
    0x84,
    0x84,
    0x07,
    ...ascii("NSValue"),
    0x00,
    0x94,
    0x84,
    0x01,
    0x2a,
    0x84,
    0x99,
    0x99,
    0x00,
    0x86,
    0x86,
    0x86,
  ]);
};

/** Apple timestamp (nanoseconds since 2001-01-01) for a JS date. */
export const appleTime = (date: Date): number =>
  (date.getTime() / 1000 - 978307200) * 1e9;

export interface FixtureMessage {
  guid: string;
  /** Stored in the `text` column; omit to leave it NULL. */
  text?: string;
  /** Stored only in `attributedBody`, as modern macOS does. */
  body?: string;
  handle?: string;
  chat?: string;
  date?: Date;
  isFromMe?: boolean;
  attachments?: FixtureAttachment[];
}

export interface FixtureAttachment {
  guid: string;
  filename: string | null;
  mime_type?: string;
  transfer_name?: string;
  total_bytes?: number;
  transfer_state?: number;
}

/** Inserts messages (and their handles, chats, attachments) into `db`. */
export const insertMessages = (
  db: Database,
  messages: FixtureMessage[],
): void => {
  const handleIds = new Map<string, number>();
  const chatIds = new Map<string, number>();
  const handleId = (id: string) => {
    if (!handleIds.has(id)) {
      const existing = db.prepare("SELECT ROWID FROM handle WHERE id = ?")
        .value<[number]>(id);
      if (existing) handleIds.set(id, existing[0]);
      else {
        db.prepare("INSERT INTO handle (id, service) VALUES (?, 'iMessage')")
          .run(id);
        handleIds.set(id, db.lastInsertRowId);
      }
    }
    return handleIds.get(id)!;
  };
  const chatId = (guid: string) => {
    if (!chatIds.has(guid)) {
      const existing = db.prepare("SELECT ROWID FROM chat WHERE guid = ?")
        .value<[number]>(guid);
      if (existing) chatIds.set(guid, existing[0]);
      else {
        db.prepare(
          "INSERT INTO chat (guid, style, state, chat_identifier) VALUES (?, 45, 3, ?)",
        ).run(guid, guid);
        chatIds.set(guid, db.lastInsertRowId);
      }
    }
    return chatIds.get(guid)!;
  };

  messages.forEach((m, i) => {
    const date = m.date ?? new Date(Date.UTC(2026, 8, 1, 12, 0, i));
    db.prepare(
      `INSERT INTO message (guid, text, attributedBody, handle_id, service,
         date, is_from_me, cache_has_attachments)
       VALUES (?, ?, ?, ?, 'iMessage', ?, ?, ?)`,
    ).run(
      m.guid,
      m.text ?? null,
      m.body !== undefined
        ? encodeAttributedBody(m.body)
        : m.text !== undefined
        ? encodeAttributedBody(m.text)
        : null,
      m.handle ? handleId(m.handle) : 0,
      appleTime(date),
      m.isFromMe ? 1 : 0,
      m.attachments?.length ? 1 : 0,
    );
    const messageId = db.lastInsertRowId;
    if (m.chat) {
      db.prepare(
        "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)",
      ).run(chatId(m.chat), messageId, appleTime(date));
    }
    for (const a of m.attachments ?? []) {
      db.prepare(
        `INSERT INTO attachment (guid, filename, mime_type, transfer_name,
           total_bytes, transfer_state) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        a.guid,
        a.filename,
        a.mime_type ?? null,
        a.transfer_name ?? null,
        a.total_bytes ?? 0,
        a.transfer_state ?? 5,
      );
      db.prepare(
        "INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)",
      ).run(messageId, db.lastInsertRowId);
    }
  });
};

/** Creates a chat.db at `path` holding `messages`. */
export const createMessagesFixture = (
  path: string,
  messages: FixtureMessage[] = [],
  { wal = false }: { wal?: boolean } = {},
): void => {
  const db = new Database(path);
  try {
    if (wal) db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    insertMessages(db, messages);
  } finally {
    db.close();
  }
};

/** Creates a fake home directory whose `~/Library/Messages/chat.db` exists. */
export const createFixtureHome = async (
  messages: FixtureMessage[] = [],
): Promise<{ home: string; dbPath: string }> => {
  const home = await Deno.makeTempDir({ prefix: "imessage-mcp-test-" });
  await Deno.mkdir(join(home, "Library", "Messages"), { recursive: true });
  const dbPath = join(home, "Library", "Messages", "chat.db");
  createMessagesFixture(dbPath, messages);
  return { home, dbPath };
};
