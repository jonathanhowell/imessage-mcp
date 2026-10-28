#!/usr/bin/env -S deno run --allow-read --allow-env --allow-sys --allow-run --allow-ffi

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import process from "node:process";
import { z } from "zod";
import {
  getAttachmentById,
  getChats,
  getHandles,
  getMessageAttachments,
  getMessagesFromChat,
  getRecentMessages,
  searchContactsByName,
  searchMessages,
  toAttachmentSummary,
} from "@wyattjoh/imessage";
import deno from "../deno.json" with { type: "json" };
import {
  type ContactsState,
  createContactsState,
  createMessagesState,
  isUnavailableError,
  type MessagesState,
} from "./state.ts";
import { exportAttachment } from "./attachment_export.ts";

const SearchMessagesSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Text to find in message content (case-insensitive substring). Matches the same body that is returned in 'text', including messages whose body is stored only in attributedBody.",
    ),
  handle: z
    .string()
    .optional()
    .describe(
      "Phone number (e.g., '+15551234') or email address to filter messages from specific contact. Get this from 'search_contacts' tool.",
    ),
  startDate: z
    .string()
    .datetime()
    .optional()
    .describe(
      "ISO datetime string (e.g., '2025-08-04T07:37:39.000Z') - only return messages after this date",
    ),
  endDate: z
    .string()
    .datetime()
    .optional()
    .describe("ISO datetime string - only return messages before this date"),
  limit: z
    .number()
    .min(1)
    .max(200)
    .default(100)
    .describe("Maximum number of messages to return (1-200, default: 100)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of messages to skip for pagination (default: 0)"),
});

const GetRecentMessagesSchema = z.object({
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(20)
    .describe(
      "Maximum number of recent messages to return (1-100, default: 20)",
    ),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of messages to skip for pagination (default: 0)"),
});

const GetChatsSchema = z.object({
  limit: z
    .number()
    .min(1)
    .max(200)
    .default(50)
    .describe("Maximum number of chats to return (1-200, default: 50)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of chats to skip for pagination (default: 0)"),
});

const GetMessagesFromChatSchema = z.object({
  chatGuid: z
    .string()
    .describe("Chat GUID identifier (obtained from 'get_chats' tool)"),
  limit: z
    .number()
    .min(1)
    .max(200)
    .default(50)
    .describe(
      "Maximum number of messages to return from this chat (1-200, default: 50)",
    ),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of messages to skip for pagination (default: 0)"),
});

const GetHandlesSchema = z.object({
  limit: z
    .number()
    .min(1)
    .max(200)
    .default(100)
    .describe("Maximum number of handles to return (1-200, default: 100)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of handles to skip for pagination (default: 0)"),
});

const SearchContactsSchema = z.object({
  firstName: z
    .string()
    .min(1)
    .describe(
      "First name to search for (e.g., 'John'). Returns phone numbers that can be used as the 'handle' parameter in 'search_messages'.",
    ),
  lastName: z
    .string()
    .optional()
    .describe(
      "Last name to search for (e.g., 'Smith'). Optional - if omitted, searches across all fields.",
    ),
  limit: z
    .number()
    .min(1)
    .max(200)
    .default(50)
    .describe("Maximum number of contacts to return (1-200, default: 50)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of contacts to skip for pagination (default: 0)"),
});

type ToolResult = {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  isError?: boolean;
};

const textResult = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
});

/**
 * Wraps a tool body: the value it returns is sent as JSON, a database that
 * cannot be opened becomes a structured `{status, message, ...}` error, and
 * any other failure is reported as `<label>: <message>`.
 */
const handler = <A>(
  label: string,
  fn: (args: A) => unknown,
) =>
  rawHandler(
    label,
    async (args: A) => textResult(JSON.stringify(await fn(args), null, 2)),
  );

/** Like {@link handler}, for a body that builds its own result content. */
const rawHandler = <A>(
  label: string,
  fn: (args: A) => Promise<ToolResult>,
) =>
async (args: A): Promise<ToolResult> => {
  try {
    return await fn(args);
  } catch (error) {
    if (isUnavailableError(error)) {
      return textResult(JSON.stringify(error.unavailable, null, 2), true);
    }
    return textResult(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export interface ServerState {
  messages: MessagesState;
  contacts: ContactsState;
}

export const GetAttachmentSchema = z.object({
  attachment_id: z
    .number()
    .int()
    .optional()
    .describe(
      "Attachment ID from a message's 'attachments' list (in search_messages, get_recent_messages or get_messages_from_chat results)",
    ),
  message_guid: z
    .string()
    .optional()
    .describe(
      "Message GUID; returns the message's first attachment and lists all of them in 'attachments'. Use attachment_id to fetch the others.",
    ),
  inline: z
    .boolean()
    .default(false)
    .describe(
      "Return the content inline (files up to 5 MB): images as an image content block, other files base64-encoded in 'data'. Default false: the file is copied to a temp path returned in 'path'.",
    ),
});

const createServer = ({ messages, contacts }: ServerState) => {
  const server = new McpServer({
    name: "imessage",
    version: deno.version,
  });

  server.tool(
    "search_messages",
    "Search iMessage messages with various filters. Use 'search_contacts' first to get handle IDs for specific contacts. Handle parameter accepts phone numbers like '+15551234' or email addresses, NOT contact names. CRITICAL: Results are paginated - for summaries, analysis, or complete conversation history, you MUST paginate through ALL results by checking 'hasMore' field and using 'offset' parameter until hasMore=false. Partial data will lead to incomplete analysis.",
    SearchMessagesSchema.shape,
    handler(
      "Error searching messages",
      (args) =>
        messages.withDatabase((db) =>
          searchMessages(db, {
            query: args.query,
            handle: args.handle,
            startDate: args.startDate ? new Date(args.startDate) : undefined,
            endDate: args.endDate ? new Date(args.endDate) : undefined,
            limit: args.limit,
            offset: args.offset,
          })
        ),
    ),
  );

  server.tool(
    "get_recent_messages",
    "Get the most recent iMessages across all conversations, ordered by date (newest first). CRITICAL: Results are paginated - for comprehensive analysis or complete recent activity overview, you MUST paginate through ALL results by checking 'hasMore' field and using 'offset' parameter until hasMore=false.",
    GetRecentMessagesSchema.shape,
    handler(
      "Error getting recent messages",
      (args) =>
        messages.withDatabase((db) =>
          getRecentMessages(db, args.limit, args.offset)
        ),
    ),
  );

  server.tool(
    "get_chats",
    "Get list of iMessage chats/conversations ordered by most recent activity. Returns chat GUIDs that can be used with 'get_messages_from_chat'. CRITICAL: Results are paginated - for complete chat listing or comprehensive conversation overview, you MUST paginate through ALL results by checking 'hasMore' field and using 'offset' parameter until hasMore=false.",
    GetChatsSchema.shape,
    handler(
      "Error getting chats",
      (args) =>
        messages.withDatabase((db) => getChats(db, args.limit, args.offset)),
    ),
  );

  server.tool(
    "get_handles",
    "Get list of all contacts/handles (phone numbers, email addresses) that have sent or received iMessages. Returns handle IDs that can be used with 'search_messages'. CRITICAL: Results are paginated - for complete contact listing or comprehensive handle overview, you MUST paginate through ALL results by checking 'hasMore' field and using 'offset' parameter until hasMore=false.",
    GetHandlesSchema.shape,
    handler(
      "Error getting handles",
      (args) =>
        messages.withDatabase((db) => getHandles(db, args.limit, args.offset)),
    ),
  );

  server.tool(
    "get_messages_from_chat",
    "Get messages from a specific chat/conversation using the chat GUID (obtained from 'get_chats'). Returns messages ordered by date (newest first). CRITICAL: Results are paginated - for complete chat history, conversation analysis, or summaries, you MUST paginate through ALL results by checking 'hasMore' field and using 'offset' parameter until hasMore=false. Partial data will lead to incomplete analysis.",
    GetMessagesFromChatSchema.shape,
    handler(
      "Error getting messages from chat",
      (args) =>
        messages.withDatabase((db) =>
          getMessagesFromChat(db, args.chatGuid, args.limit, args.offset)
        ),
    ),
  );

  server.tool(
    "get_attachment",
    "Retrieve a file attached to an iMessage: photos (HEIC is converted to JPEG so it can be viewed), PDFs, videos, voice notes, contact cards and other files. Identify it by attachment_id (from a message's 'attachments' list) or message_guid. By default the file is copied to a temp path and the response is {status, path, mime_type, byte_size, filename}; read the file at 'path'. Pass inline: true to get the content in the response instead (files up to 5 MB). 'status' is always set: 'ok', 'no_attachment' (the message has none), 'not_downloaded' (not on this Mac, e.g. offloaded to iCloud: open the chat in Messages, then retry), 'missing' (recorded as downloaded but the file is gone), 'unreadable' (no permission, usually Full Disk Access) or 'not_found' (no such attachment or message).",
    GetAttachmentSchema.shape,
    rawHandler("Error getting attachment", async (args) => {
      const json = (value: unknown) =>
        textResult(JSON.stringify(value, null, 2));
      if ((args.attachment_id === undefined) === !args.message_guid) {
        return textResult(
          "Error getting attachment: pass exactly one of attachment_id or message_guid",
          true,
        );
      }
      // Look the rows up with the database open, then close it before the
      // (possibly slow) file copy and HEIC conversion.
      const found = await messages.withDatabase((db) => {
        if (args.attachment_id !== undefined) {
          const row = getAttachmentById(db, args.attachment_id);
          return row ? { row } : {
            early: {
              status: "not_found",
              attachment_id: args.attachment_id,
              note: "No attachment with this ID.",
            },
          };
        }
        const list = getMessageAttachments(db, args.message_guid!);
        if (!list) {
          return {
            early: {
              status: "not_found",
              message_guid: args.message_guid,
              note: "No message with this GUID.",
            },
          };
        }
        if (list.length === 0) {
          return {
            early: {
              status: "no_attachment",
              message_guid: args.message_guid,
              note: "This message has no attachments.",
            },
          };
        }
        return {
          row: { ...list[0]!, message_guid: args.message_guid },
          siblings: list.map(toAttachmentSummary),
        };
      });
      if (!found.row) return json(found.early);
      const { row, siblings } = found;

      const { data, ...result } = await exportAttachment(row, {
        inline: args.inline,
      });
      const payload = siblings ? { ...result, attachments: siblings } : result;
      if (data === undefined) return json(payload);
      if (String(result.mime_type).startsWith("image/")) {
        return {
          content: [
            { type: "text", text: JSON.stringify(payload, null, 2) },
            { type: "image", data, mimeType: String(result.mime_type) },
          ],
        };
      }
      return json({ ...payload, data });
    }),
  );

  server.tool(
    "refresh_database",
    "Make subsequent reads see the latest iMessage data. In live mode (default) every tool call already opens the database afresh and closes it afterwards, so this only checks that the database can be opened (useful after db_unavailable, e.g. once Full Disk Access is granted). In snapshot mode (IMESSAGE_DB_MODE=snapshot) it builds a fresh snapshot; if that fails the previous snapshot stays in use. Returns {status: 'ok', mode, source_path, path, opened_at, snapshot?}, or {status: 'db_unavailable' | 'snapshot_failed', message, still_serving}.",
    {},
    handler("Error refreshing database", async () => ({
      status: "ok",
      ...(await messages.refresh()),
    })),
  );

  server.tool(
    "search_contacts",
    "Search for contacts by first name and optional last name. Use this FIRST when searching for messages from a specific person - it returns the phone number that can be used as the 'handle' parameter in 'search_messages'. Example: search for firstName='John' lastName='Smith' to get his phone number, then use that phone number in search_messages. If lastName is omitted, searches across all name fields. CRITICAL: Results are paginated - for complete contact search results, check 'hasMore' field and use 'offset' parameter until hasMore=false. If the Contacts databases cannot be read, returns {status: 'contacts_unavailable', message}; message tools keep working.",
    SearchContactsSchema.shape,
    handler("Error searching contacts", (args) =>
      searchContactsByName(
        contacts.acquire(),
        args.firstName,
        args.lastName,
        args.limit,
        args.offset,
      )),
  );

  return server;
};

export const main = async (): Promise<void> => {
  const state: ServerState = {
    messages: createMessagesState(),
    contacts: createContactsState(),
  };
  const server = createServer(state);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    state.messages.close();
    state.contacts.close();
    Deno.exit(0);
  };
  transport.onclose = shutdown;
  process.stdin.on("end", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
  Deno.addSignalListener("SIGINT", shutdown);

  // Connect FIRST: the handshake must never depend on database access, so a
  // missing Full Disk Access grant surfaces as a tool error, not a dead server.
  await server.connect(transport);
  const { mode, path } = state.messages.config;
  console.error(
    `iMessage MCP Server running on stdio (mode: ${mode}, database: ${path})`,
  );

  // Open (or snapshot) in the background; tools wait for it or report status.
  state.messages.start().then(() => {
    const info = state.messages.info();
    if (info) console.error(`Reading ${info.path}`);
  });
};

export const run = (): void => {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    Deno.exit(1);
  });
};

if (import.meta.main) run();
