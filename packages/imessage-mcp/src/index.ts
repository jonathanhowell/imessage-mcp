#!/usr/bin/env -S deno run --allow-read --allow-env --allow-sys --allow-run --allow-ffi

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import process from "node:process";
import { z } from "zod";
import {
  getChats,
  getHandles,
  getMessagesFromChat,
  getRecentMessages,
  searchContactsByName,
  searchMessages,
} from "@wyattjoh/imessage";
import deno from "../deno.json" with { type: "json" };
import {
  type ContactsState,
  createContactsState,
  createMessagesState,
  isUnavailableError,
  type MessagesState,
} from "./state.ts";

const SearchMessagesSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Full-text search query to find in message content"),
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
  content: { type: "text"; text: string }[];
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
async (args: A): Promise<ToolResult> => {
  try {
    return textResult(JSON.stringify(await fn(args), null, 2));
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

export const createServer = ({ messages, contacts }: ServerState) => {
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
      async (args) =>
        searchMessages(await messages.acquire(), {
          query: args.query,
          handle: args.handle,
          startDate: args.startDate ? new Date(args.startDate) : undefined,
          endDate: args.endDate ? new Date(args.endDate) : undefined,
          limit: args.limit,
          offset: args.offset,
        }),
    ),
  );

  server.tool(
    "get_recent_messages",
    "Get the most recent iMessages across all conversations, ordered by date (newest first). CRITICAL: Results are paginated - for comprehensive analysis or complete recent activity overview, you MUST paginate through ALL results by checking 'hasMore' field and using 'offset' parameter until hasMore=false.",
    GetRecentMessagesSchema.shape,
    handler(
      "Error getting recent messages",
      async (args) =>
        getRecentMessages(await messages.acquire(), args.limit, args.offset),
    ),
  );

  server.tool(
    "get_chats",
    "Get list of iMessage chats/conversations ordered by most recent activity. Returns chat GUIDs that can be used with 'get_messages_from_chat'. CRITICAL: Results are paginated - for complete chat listing or comprehensive conversation overview, you MUST paginate through ALL results by checking 'hasMore' field and using 'offset' parameter until hasMore=false.",
    GetChatsSchema.shape,
    handler(
      "Error getting chats",
      async (args) =>
        getChats(await messages.acquire(), args.limit, args.offset),
    ),
  );

  server.tool(
    "get_handles",
    "Get list of all contacts/handles (phone numbers, email addresses) that have sent or received iMessages. Returns handle IDs that can be used with 'search_messages'. CRITICAL: Results are paginated - for complete contact listing or comprehensive handle overview, you MUST paginate through ALL results by checking 'hasMore' field and using 'offset' parameter until hasMore=false.",
    GetHandlesSchema.shape,
    handler(
      "Error getting handles",
      async (args) =>
        getHandles(await messages.acquire(), args.limit, args.offset),
    ),
  );

  server.tool(
    "get_messages_from_chat",
    "Get messages from a specific chat/conversation using the chat GUID (obtained from 'get_chats'). Returns messages ordered by date (newest first). CRITICAL: Results are paginated - for complete chat history, conversation analysis, or summaries, you MUST paginate through ALL results by checking 'hasMore' field and using 'offset' parameter until hasMore=false. Partial data will lead to incomplete analysis.",
    GetMessagesFromChatSchema.shape,
    handler(
      "Error getting messages from chat",
      async (args) =>
        getMessagesFromChat(
          await messages.acquire(),
          args.chatGuid,
          args.limit,
          args.offset,
        ),
    ),
  );

  server.tool(
    "refresh_database",
    "Make subsequent reads see the latest iMessage data. In live mode (default) this closes and reopens the database connection, which also picks up a replaced IMESSAGE_DB_PATH file and retries after db_unavailable. In snapshot mode (IMESSAGE_DB_MODE=snapshot) it builds a fresh snapshot; if that fails the previous snapshot stays in use. Returns {status: 'ok', mode, source_path, path, opened_at, snapshot?}, or {status: 'db_unavailable' | 'snapshot_failed', message, still_serving}.",
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
