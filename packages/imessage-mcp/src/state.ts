import { Database } from "@db/sqlite";
import {
  findContactsDatabasePaths,
  getContactsSourcesPath,
  getImessageDbPath,
  openMessagesDatabase,
} from "@wyattjoh/imessage";

/** Structured reason a tool could not reach a database. */
export interface UnavailableInfo {
  status: "db_unavailable" | "contacts_unavailable";
  message: string;
  path: string;
  [key: string]: unknown;
}

/** Error carrying an {@link UnavailableInfo}, turned into a tool result. */
export type UnavailableError = Error & { unavailable: UnavailableInfo };

export const createUnavailableError = (
  info: UnavailableInfo,
): UnavailableError =>
  Object.assign(new Error(info.message), { unavailable: info });

export const isUnavailableError = (
  error: unknown,
): error is UnavailableError =>
  error instanceof Error && "unavailable" in error;

const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return error.name === "SqliteError" && typeof code === "number"
    ? `SqliteError ${code}: ${error.message.replace(/^\d+:\s*/, "")}`
    : `${error.name}: ${error.message}`;
};

const FDA_HINT =
  "This is usually a missing Full Disk Access grant for the process that " +
  "launched the server — a LaunchAgent does not inherit the terminal's " +
  `grant. Grant Full Disk Access to ${Deno.execPath()} (System Settings > ` +
  "Privacy & Security > Full Disk Access), or point IMESSAGE_DB_PATH at a " +
  "snapshot readable without it.";

/**
 * Turn a failed open into an actionable message. Without Full Disk Access
 * macOS reports even stat() on a protected path as "Operation not
 * permitted", so a missing file and a missing grant can be told apart.
 */
export const explainOpenError = (error: unknown, path: string): string => {
  const cause = errorText(error);
  if (error instanceof Deno.errors.NotCapable) {
    return `cannot open ${path} (${cause}). The Deno permission flags do ` +
      "not allow reading this path; add --allow-read for it.";
  }
  try {
    Deno.statSync(path);
  } catch (statError) {
    if (statError instanceof Deno.errors.NotFound) {
      return `cannot open ${path} (${cause}). The file does not exist.`;
    }
  }
  return `cannot open ${path} (${cause}). ${FDA_HINT}`;
};

/** Lazily opened read-only handle on the Messages database. */
export interface MessagesState {
  /** Resolved path of the database being read. */
  readonly path: string;
  /** Returns the open handle, opening it on first use. */
  acquire(): Promise<Database>;
  close(): void;
}

export const createMessagesState = (
  open: (path: string) => Database = openMessagesDatabase,
): MessagesState => {
  const path = getImessageDbPath();
  let db: Database | null = null;

  return {
    path,
    acquire() {
      if (db) return Promise.resolve(db);
      try {
        db = open(path);
        return Promise.resolve(db);
      } catch (error) {
        return Promise.reject(createUnavailableError({
          status: "db_unavailable",
          message: explainOpenError(error, path),
          path,
        }));
      }
    },
    close() {
      db?.close();
      db = null;
    },
  };
};

/** Lazily opened handles on every AddressBook database. */
export interface ContactsState {
  acquire(): Database[];
  close(): void;
}

export const createContactsState = (): ContactsState => {
  let dbs: Database[] | null = null;

  return {
    acquire() {
      if (dbs) return dbs;
      let path = getContactsSourcesPath();
      const opened: Database[] = [];
      try {
        for (path of findContactsDatabasePaths()) {
          opened.push(new Database(path, { readonly: true }));
        }
      } catch (error) {
        for (const db of opened) db.close();
        throw createUnavailableError({
          status: "contacts_unavailable",
          message: explainOpenError(error, path),
          path,
        });
      }
      dbs = opened;
      return dbs;
    },
    close() {
      for (const db of dbs ?? []) db.close();
      dbs = null;
    },
  };
};
