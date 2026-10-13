// Copies the Messages database in a worker so the MCP transport stays
// responsive while it runs, and so a wedged copy can be abandoned.
import { Database } from "@db/sqlite";
import { errorText } from "./errors.ts";

export interface SnapshotWorkerInput {
  sourcePath: string;
  tmpPath: string;
}

export type SnapshotWorkerOutput =
  | { ok: true; method: "backup" | "vacuum_into"; backupError?: string }
  | { ok: false; error: string };

const removeIfExists = (path: string): void => {
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try {
      Deno.removeSync(file);
    } catch {
      // not present
    }
  }
};

/**
 * Online backup in ONE step (pages = -1): every page is copied inside a single
 * read transaction, so writes to chat.db while it runs cannot restart it, and
 * pages still in chat.db-wal are included. A page-stepped backup restarts on
 * every source write and may never finish.
 */
const viaBackup = (source: Database, tmpPath: string): void => {
  const dest = new Database(tmpPath);
  try {
    source.backup(dest, "main", -1);
  } finally {
    dest.close();
  }
};

export const copyDatabase = (
  { sourcePath, tmpPath }: SnapshotWorkerInput,
): SnapshotWorkerOutput => {
  removeIfExists(tmpPath);
  const source = new Database(sourcePath, { readonly: true });
  let result: SnapshotWorkerOutput;
  try {
    try {
      viaBackup(source, tmpPath);
      result = { ok: true, method: "backup" };
    } catch (error) {
      // VACUUM INTO also reads in one transaction and works read-only.
      removeIfExists(tmpPath);
      source.exec("VACUUM INTO ?", tmpPath);
      result = {
        ok: true,
        method: "vacuum_into",
        backupError: errorText(error),
      };
    }
  } finally {
    source.close();
  }

  // Leave a single self-contained file (no -wal/-shm sidecars) so it can be
  // renamed atomically and opened read-only by anyone.
  const snapshot = new Database(tmpPath);
  try {
    snapshot.exec("PRAGMA journal_mode = DELETE");
  } finally {
    snapshot.close();
  }
  return result;
};

interface WorkerScope {
  name: string;
  postMessage(message: SnapshotWorkerOutput): void;
  close(): void;
}

// The input arrives in the worker's name rather than a message: @db/sqlite
// loads its native library with top-level await, and a message posted while
// that is pending can arrive before any handler is installed.
if ("WorkerGlobalScope" in globalThis) {
  const scope = globalThis as unknown as WorkerScope;
  const input = JSON.parse(scope.name) as SnapshotWorkerInput;
  let out: SnapshotWorkerOutput;
  try {
    out = copyDatabase(input);
  } catch (error) {
    removeIfExists(input.tmpPath);
    out = { ok: false, error: errorText(error) };
  }
  scope.postMessage(out);
  scope.close();
}
