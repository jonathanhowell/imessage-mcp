# iMessage MCP

A Deno monorepo containing packages for iMessage access on macOS:

- **[@wyattjoh/imessage](packages/imessage)** - Core library for read-only iMessage database access
- **[@wyattjoh/imessage-mcp](packages/imessage-mcp)** - Model Context Protocol (MCP) server for LLM integration

## Features

- Search messages by text content, contact, or date range
- Get recent messages
- List all chats/conversations
- Get all contacts/handles
- Optional snapshot mode, and a `refresh_database` tool
- Retrieve messages from specific chats
- Search macOS Contacts by name with iMessage handle ID correlation

## Requirements

- macOS (iMessage is only available on macOS)
- Deno 2.x or later
- Read access to `~/Library/Messages/chat.db`
- Read access to `~/Library/Application Support/AddressBook/` (for contacts search)

## Packages

### @wyattjoh/imessage

Core library for accessing iMessage data:

```bash
deno add @wyattjoh/imessage
```

```typescript
import { openMessagesDatabase, searchMessages } from "@wyattjoh/imessage";

const db = await openMessagesDatabase();
const results = await searchMessages(db, { query: "hello" });
db.close();
```

[See full documentation](packages/imessage/README.md)

### @wyattjoh/imessage-mcp

MCP server for LLM integration:

```bash
# Run directly from JSR
deno run --allow-read --allow-env --allow-sys --allow-ffi --allow-write --allow-run jsr:@wyattjoh/imessage-mcp

# Or install globally
deno install --global --allow-read --allow-env --allow-sys --allow-ffi --allow-write --allow-run -n imessage-mcp jsr:@wyattjoh/imessage-mcp
```

For Claude Desktop app integration, add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "deno",
      "args": [
        "run",
        "--allow-read",
        "--allow-env",
        "--allow-sys",
        "--allow-ffi",
        "--allow-write",
        "--allow-run",
        "jsr:@wyattjoh/imessage-mcp"
      ]
    }
  }
}
```

### Option 2: From Source

1. Clone this repository
2. Install dependencies:
   ```bash
   deno cache src/index.ts
   ```
3. Run the server:
   ```bash
   deno run --allow-read --allow-env --allow-sys --allow-ffi src/index.ts
   # Or use the task:
   deno task start
   ```

### Available Tools

All tools except `search_contacts` and `refresh_database` read the Messages
database. If it cannot be read they return a structured
`{"status": ..., "message": ...}` error (see below) instead of data.

1. **search_messages** - Search messages with filters
   - `query` (optional): Text to search for (case-insensitive substring). It
     matches the same body returned in `text`, including messages whose body is
     stored only in `attributedBody` (common on recent macOS, especially SMS/RCS)
   - `handle` (optional): Phone number or email to filter by
   - `startDate` (optional): ISO datetime string for start date
   - `endDate` (optional): ISO datetime string for end date
   - `limit` (optional): Maximum results (1-200, default: 100)
   - `offset` (optional): Pagination offset (default: 0)

2. **get_recent_messages** - Get the most recent messages
   - `limit` (optional): Number of messages (1-100, default: 20)
   - `offset` (optional): Pagination offset (default: 0)

3. **get_chats** - List all conversations
   - `limit` (optional): Number of chats (1-200, default: 50)
   - `offset` (optional): Pagination offset (default: 0)

4. **get_handles** - Get all contacts/handles

- Optional snapshot mode, and a `refresh_database` tool
  - `limit` (optional): Number of handles (1-200, default: 100)
  - `offset` (optional): Pagination offset (default: 0)

5. **get_messages_from_chat** - Get messages from a specific chat
   - `chatGuid` (required): The chat GUID
   - `limit` (optional): Number of messages (1-200, default: 50)
   - `offset` (optional): Pagination offset (default: 0)

6. **search_contacts** - Search macOS Contacts by name and get phone numbers
   - `firstName` (required): First name to search for (e.g., 'John')
   - `lastName` (optional): Last name to search for (e.g., 'Smith'). If omitted, searches across all name fields
   - `limit` (optional): Maximum results (1-200, default: 50)
   - `offset` (optional): Pagination offset (default: 0)
   - Returns contact info with phone numbers and email addresses that can be used as handle parameters
   - Searches directly in the macOS AddressBook database for better performance and reliability

7. **refresh_database** - Make later reads see the latest messages (no parameters)
   - Live mode: closes and reopens the connection
   - Snapshot mode: builds a fresh snapshot, keeping the previous one if that fails
   - Returns `{status: "ok", mode, source_path, path, opened_at, snapshot?}`, or `{status: "db_unavailable" | "snapshot_failed", message, still_serving}`

### Pagination Examples

All tools now support pagination using `limit` and `offset` parameters and return pagination metadata:

```javascript
// Get first 20 recent messages
get_recent_messages({ limit: 20, offset: 0 });

// Get next 20 recent messages (page 2)
get_recent_messages({ limit: 20, offset: 20 });

// Get first 10 chats
get_chats({ limit: 10, offset: 0 });

// Get messages 51-100 from a specific chat
get_messages_from_chat({
  chatGuid: "iMessage;-;+15551234",
  limit: 50,
  offset: 50,
});

// Search with pagination
search_messages({
  query: "meeting",
  limit: 100,
  offset: 200,
});

// Search contacts with pagination
search_contacts({
  firstName: "John",
  lastName: "Smith",
  limit: 50,
  offset: 0,
});
```

#### Response Format with Pagination Metadata

All paginated tools now return responses in this format:

```json
{
  "data": [
    // Array of results (messages, chats, handles, etc.)
  ],
  "pagination": {
    "total": 1250, // Total number of results available
    "limit": 100, // Current page size
    "offset": 200, // Current offset
    "hasMore": true, // Whether there are more results to fetch
    "page": 3, // Current page number (1-indexed)
    "totalPages": 13 // Total number of pages
  }
}
```

This metadata helps you:

- Know the total number of results without fetching all of them
- Determine if there are more pages to fetch (`hasMore`)
- Calculate which page you're on and how many pages exist
- Build proper pagination UI components

### Configuration

| Environment variable                | Default                      | Purpose                                                                                                    |
| ----------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `IMESSAGE_DB_PATH`                  | `~/Library/Messages/chat.db` | Messages database to read. Point it at a snapshot so a process without Full Disk Access can read messages. |
| `IMESSAGE_DB_MODE`                  | `live`                       | `live` reads the database directly. `snapshot` reads a private copy made at startup (see below).           |
| `IMESSAGE_SNAPSHOT_DIR`             | `$TMPDIR/imessage-mcp`       | Where snapshot mode writes its copies.                                                                     |
| `IMESSAGE_SNAPSHOT_TIMEOUT_SECONDS` | `120`                        | Deadline for building a snapshot before it is abandoned.                                                   |

Set and non-empty values win (a leading `~/` in `IMESSAGE_DB_PATH` is
expanded). The resolved path is logged at startup and included in
`db_unavailable` errors.

### Live and snapshot modes

In **live** mode (the default) the server reads `chat.db` directly. SQLite
readers see new messages, including ones still in `chat.db-wal`, on every
query, so live reads are always current. `refresh_database` closes and reopens
the connection. Use it after replacing the file at `IMESSAGE_DB_PATH`, or to
retry after `db_unavailable` (for example, once Full Disk Access is granted).

In **snapshot** mode (`IMESSAGE_DB_MODE=snapshot`) the server copies the
database after the MCP handshake and serves every read from that copy until
`refresh_database` builds a new one:

- The copy uses SQLite's online backup in a single step, so it includes pages
  that are still only in `chat.db-wal` (a plain file copy of `chat.db` does not)
  and cannot be restarted by Messages writing during the copy. `VACUUM INTO`
  is the fallback. The copy runs in a worker thread, so the server keeps
  answering while it runs.
- The copy is written to `snapshot-<pid>.sqlite.tmp` (mode 0600) and renamed to
  `snapshot-<pid>.sqlite`. Then `latest.sqlite` is atomically repointed at it.
  Each instance has its own file; only files whose owning process has exited
  are removed, and never the one `latest.sqlite` points at.
- While the first copy is being built, tools wait up to 20 seconds and then
  return `{"status": "snapshot_pending", ...}`. A failed copy returns
  `{"status": "snapshot_failed", "message": ...}`, and the next tool call or
  `refresh_database` retries. A failed refresh keeps serving the previous copy
  (`still_serving` in the response).

`$TMPDIR/imessage-mcp/latest.sqlite` always points at the newest good snapshot
from any instance. That lets a process without Full Disk Access read messages:
run one instance in snapshot mode from a context that has FDA (for example,
your terminal), and point the headless one at the link:

```bash
IMESSAGE_DB_PATH="$TMPDIR/imessage-mcp/latest.sqlite"  # live mode (default)
```

The headless instance then calls `refresh_database` to pick up a newer
snapshot. Offline tools can read it with
`sqlite3 "file:$TMPDIR/imessage-mcp/latest.sqlite?immutable=1"`.

A LaunchAgent may not have `TMPDIR` set. In that case the server asks macOS
for the per-user temp directory (`getconf DARWIN_USER_TEMP_DIR`), which is the
same directory an interactive shell uses. For a headless consumer, prefer an
absolute `IMESSAGE_DB_PATH`.

### Permissions

| Flag                         | Needed for                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--allow-read`               | The Messages and Contacts databases                                                                                                                                        |
| `--allow-env`, `--allow-sys` | Configuration and the home directory                                                                                                                                       |
| `--allow-ffi`                | SQLite native bindings                                                                                                                                                     |
| `--allow-write`              | Snapshot mode (writes under `IMESSAGE_SNAPSHOT_DIR`)                                                                                                                       |
| `--allow-run`                | Snapshot mode: checking whether other instances are still running, so their files are not removed (without it nothing is cleaned up), and `getconf` when `TMPDIR` is unset |

### When a database cannot be opened

The server always completes the MCP handshake, even if it cannot read the
Messages or Contacts databases. Each database is opened on first use, and
failures come back as a structured tool error (`isError: true`) instead of the
process exiting:

```json
{
  "status": "db_unavailable",
  "message": "cannot open /Users/you/Library/Messages/chat.db (SqliteError 14: unable to open database file). This is usually a missing Full Disk Access grant for the process that launched the server ...",
  "path": "/Users/you/Library/Messages/chat.db"
}
```

`search_contacts` reports `contacts_unavailable` in the same way, and the
message tools keep working.

The usual cause is Full Disk Access (FDA). macOS grants FDA to the app that
launched the process (for example, your terminal), so a server started from a
LaunchAgent or another headless context does not inherit it. Grant FDA to the
`deno` binary named in the message (System Settings > Privacy & Security > Full
Disk Access), or set `IMESSAGE_DB_PATH` to a snapshot that a process holding
FDA has written.

The server exits with status 0 when its stdin or the MCP transport closes.

## Security Notes

- This server runs with read-only access to the iMessage database
- No messages can be sent or modified
- The server only accesses local data

## Development

This is a Deno workspace monorepo. All commands run from the root affect all packages.

```bash
# Clone the repository
git clone https://github.com/wyattjoh/imessage-mcp.git
cd imessage-mcp

# Cache dependencies
deno cache packages/*/mod.ts

# Format all code
deno task fmt

# Lint all packages
deno task lint

# Type check all packages
deno task check

# Run tests
deno task test

# Run MCP server locally
cd packages/imessage-mcp
deno run --allow-read --allow-env --allow-sys --allow-ffi --allow-write --allow-run mod.ts

# Publish packages (CI/CD)
deno publish
```

### Working on Individual Packages

```bash
# Work on @wyattjoh/imessage
cd packages/imessage
deno task test  # from the repository root: fixture-based tests

# Work on @wyattjoh/imessage-mcp
cd packages/imessage-mcp
deno run --allow-read --allow-env --allow-sys --allow-ffi mod.ts
```

## License

MIT
