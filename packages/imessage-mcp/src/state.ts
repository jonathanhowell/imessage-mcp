import { Database } from "@db/sqlite";
import { join } from "node:path";
import {
  findContactsDatabasePaths,
  getContactsSourcesPath,
  getImessageDbPath,
  openMessagesDatabase,
} from "@wyattjoh/imessage";
import { errorText } from "./errors.ts";
import {
  createSnapshot,
  defaultSnapshotDir,
  LATEST_LINK,
  removeOwnSnapshot,
} from "./snapshot.ts";

/** Structured reason a tool could not reach a database. */
export interface UnavailableInfo {
  status:
    | "db_unavailable"
    | "contacts_unavailable"
    | "snapshot_pending"
    | "snapshot_failed";
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
      "not allow this; see the README for the required --allow-* flags.";
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

export type DbMode = "live" | "snapshot";

export interface MessagesConfig {
  mode: DbMode;
  /** Database to read (live) or copy (snapshot). */
  path: string;
  snapshotDir: string;
  snapshotTimeoutMs: number;
  /** How long a tool call waits for an in-flight snapshot. */
  acquireWaitMs: number;
}

const DEFAULT_SNAPSHOT_TIMEOUT_SECONDS = 120;

const positive = (value: string | undefined): number | undefined => {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Reads IMESSAGE_DB_MODE, IMESSAGE_DB_PATH and the snapshot settings. */
export const loadMessagesConfig = (): MessagesConfig => {
  const mode = Deno.env.get("IMESSAGE_DB_MODE")?.trim().toLowerCase();
  if (mode && mode !== "live" && mode !== "snapshot") {
    console.error(`Ignoring IMESSAGE_DB_MODE=${mode}; expected live|snapshot`);
  }
  return {
    mode: mode === "snapshot" ? "snapshot" : "live",
    path: getImessageDbPath(),
    snapshotDir: defaultSnapshotDir(),
    snapshotTimeoutMs: (positive(
      Deno.env.get("IMESSAGE_SNAPSHOT_TIMEOUT_SECONDS"),
    ) ?? DEFAULT_SNAPSHOT_TIMEOUT_SECONDS) * 1000,
    acquireWaitMs: 20_000,
  };
};

/** What the server is currently reading. */
export interface DatabaseInfo {
  mode: DbMode;
  /** The configured database (chat.db or IMESSAGE_DB_PATH). */
  source_path: string;
  /** The file actually open: source_path in live mode, else the snapshot. */
  path: string;
  opened_at: string;
  snapshot?: {
    created_at: string;
    method: "backup" | "vacuum_into";
    duration_ms: number;
    latest_link: string;
  };
}

/** Lazily opened read-only handle on the Messages database. */
export interface MessagesState {
  readonly config: MessagesConfig;
  /** Begins opening (or snapshotting) in the background; idempotent. */
  start(): Promise<void>;
  /** Returns the open handle, or throws an {@link UnavailableError}. */
  acquire(): Promise<Database>;
  /**
   * Live: closes and reopens the connection. Snapshot: builds a fresh copy,
   * keeping the previous one if that fails.
   */
  refresh(): Promise<DatabaseInfo>;
  info(): DatabaseInfo | null;
  close(): void;
}

export const createMessagesState = (
  config: MessagesConfig = loadMessagesConfig(),
  log: (message: string) => void = console.error,
  snapshotWith: typeof createSnapshot = createSnapshot,
): MessagesState => {
  const { mode, path } = config;
  let current: { db: Database; info: DatabaseInfo } | null = null;
  let inflight: Promise<void> | null = null;
  let lastError: UnavailableInfo | null = null;
  let startedAt: string | null = null;

  const swap = (db: Database, info: DatabaseInfo) => {
    const previous = current;
    current = { db, info };
    previous?.db.close();
  };

  const openLive = () => {
    try {
      swap(openMessagesDatabase(path), {
        mode,
        source_path: path,
        path,
        opened_at: new Date().toISOString(),
      });
      lastError = null;
    } catch (error) {
      lastError = {
        status: "db_unavailable",
        message: explainOpenError(error, path),
        path,
      };
    }
  };

  const buildSnapshot = async () => {
    try {
      const snapshot = await snapshotWith(path, {
        dir: config.snapshotDir,
        timeoutMs: config.snapshotTimeoutMs,
      });
      swap(openMessagesDatabase(snapshot.path), {
        mode,
        source_path: path,
        path: snapshot.path,
        opened_at: new Date().toISOString(),
        snapshot: {
          created_at: snapshot.createdAt,
          method: snapshot.method,
          duration_ms: snapshot.durationMs,
          latest_link: join(config.snapshotDir, LATEST_LINK),
        },
      });
      lastError = null;
      log(
        `Snapshot of ${path} ready at ${snapshot.path} via ${snapshot.method} ` +
          `in ${snapshot.durationMs}ms` +
          (snapshot.backupError
            ? ` (online backup failed: ${snapshot.backupError})`
            : ""),
      );
    } catch (error) {
      lastError = {
        status: "snapshot_failed",
        message: `snapshot failed: ${explainOpenError(error, path)}`,
        path,
        snapshot_dir: config.snapshotDir,
        attempted_at: startedAt,
        hint: "Call refresh_database, or any tool, to retry.",
      };
      log(lastError.message);
    }
  };

  const start = () => {
    if (!inflight) {
      startedAt = new Date().toISOString();
      inflight =
        (mode === "live" ? Promise.resolve(openLive()) : buildSnapshot())
          .finally(() => {
            inflight = null;
          });
    }
    return inflight;
  };

  const unavailable = (): UnavailableError =>
    createUnavailableError(
      inflight
        ? {
          status: "snapshot_pending",
          message:
            "The iMessage database snapshot is still being created. Retry shortly.",
          path,
          started_at: startedAt,
          deadline_seconds: Math.round(config.snapshotTimeoutMs / 1000),
        }
        : lastError!,
    );

  return {
    config,
    start,
    async acquire() {
      if (current) return current.db;
      // Nothing usable yet (or the last attempt failed): try now.
      const pending = start();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending,
        new Promise((resolve) => {
          timer = setTimeout(resolve, config.acquireWaitMs);
        }),
      ]);
      clearTimeout(timer);
      // `current` is reassigned by the load that was awaited above.
      const opened = current as { db: Database } | null;
      if (opened) return opened.db;
      throw unavailable();
    },
    async refresh() {
      if (inflight) await inflight;
      // The previous handle is only replaced once the new one is open.
      await start();
      if (lastError) {
        throw createUnavailableError({
          ...lastError,
          still_serving: current?.info ?? null,
        });
      }
      return current!.info;
    },
    info: () => current?.info ?? null,
    close() {
      current?.db.close();
      current = null;
      if (mode === "snapshot") {
        try {
          removeOwnSnapshot(config.snapshotDir);
        } catch {
          // best effort
        }
      }
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
