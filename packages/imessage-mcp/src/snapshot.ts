import process from "node:process";
import { basename, join, resolve } from "node:path";
import type {
  SnapshotWorkerInput,
  SnapshotWorkerOutput,
} from "./snapshot_worker.ts";

/** Stable pointer to the newest good snapshot written by any instance. */
export const LATEST_LINK = "latest.sqlite";

const SNAPSHOT_RE = /^snapshot-(\d+)\.sqlite(\.tmp)?(-wal|-shm|-journal)?$/;

/**
 * The per-user temp directory. A LaunchAgent may run without TMPDIR set, so
 * ask macOS for the same directory an interactive shell would get rather than
 * silently diverging to /tmp.
 */
export const userTempDir = (): string => {
  const env = Deno.env.get("TMPDIR");
  if (env) return env;
  try {
    const out = new Deno.Command("/usr/bin/getconf", {
      args: ["DARWIN_USER_TEMP_DIR"],
      stderr: "null",
    }).outputSync();
    const dir = new TextDecoder().decode(out.stdout).trim();
    if (out.success && dir) return dir;
  } catch {
    // no --allow-run, or not macOS
  }
  return "/tmp";
};

/** `$IMESSAGE_SNAPSHOT_DIR`, else `$TMPDIR/imessage-mcp`. */
export const defaultSnapshotDir = (): string =>
  Deno.env.get("IMESSAGE_SNAPSHOT_DIR")?.trim() ||
  join(userTempDir(), "imessage-mcp");

export const snapshotPathFor = (dir: string, pid: number): string =>
  join(dir, `snapshot-${pid}.sqlite`);

/**
 * Whether a process exists. Needs --allow-run; without it every owner counts
 * as alive, so cleanup never removes a file it cannot prove is orphaned.
 */
export const isPidAlive = (pid: number): boolean => {
  if (pid === Deno.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
};

/** Absolute path `latest.sqlite` points at, if it points at a real file. */
export const readLatestTarget = (dir: string): string | null => {
  try {
    const target = resolve(dir, Deno.readLinkSync(join(dir, LATEST_LINK)));
    return Deno.statSync(target).isFile ? target : null;
  } catch {
    return null;
  }
};

const pointLatestAt = (dir: string, snapshotPath: string): void => {
  // Create a uniquely named link, then rename it over the old one.
  const tmpLink = join(dir, `.${LATEST_LINK}.${Deno.pid}.tmp`);
  try {
    Deno.removeSync(tmpLink);
  } catch {
    // not present
  }
  Deno.symlinkSync(basename(snapshotPath), tmpLink);
  Deno.renameSync(tmpLink, join(dir, LATEST_LINK));
};

/**
 * Removes snapshot files whose owning process has exited. Files of live
 * instances are never touched, and neither is the `latest.sqlite` target, so
 * the newest good snapshot survives until a newer one replaces it.
 */
export const cleanStaleSnapshots = (dir: string): string[] => {
  const latest = readLatestTarget(dir);
  const latestBase = latest ? basename(latest) : null;
  const removed: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return removed;
  }
  for (const { name } of entries) {
    const match = SNAPSHOT_RE.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (isPidAlive(pid)) continue;
    const isTmp = Boolean(match[2]);
    if (!isTmp && `snapshot-${pid}.sqlite` === latestBase) continue;
    try {
      Deno.removeSync(join(dir, name));
      removed.push(name);
    } catch {
      // raced with another instance
    }
  }
  return removed;
};

/** On exit: drop our snapshot unless `latest.sqlite` points at it. */
export const removeOwnSnapshot = (dir: string, pid = Deno.pid): void => {
  const own = snapshotPathFor(dir, pid);
  const files = [`${own}.tmp`];
  if (readLatestTarget(dir) !== own) files.push(own);
  for (const file of files) {
    try {
      Deno.removeSync(file);
    } catch {
      // not present
    }
  }
};

const runWorker = (
  input: SnapshotWorkerInput,
  timeoutMs: number,
): Promise<SnapshotWorkerOutput> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./snapshot_worker.ts", import.meta.url).href,
      { type: "module", name: JSON.stringify(input) },
    );
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      worker.terminate();
      fn();
    };
    const timer = setTimeout(() =>
      finish(() =>
        reject(
          new Error(
            `snapshot copy exceeded the ${
              Math.round(timeoutMs / 1000)
            }s deadline and was abandoned`,
          ),
        )
      ), timeoutMs);
    worker.onmessage = (event: MessageEvent<SnapshotWorkerOutput>) =>
      finish(() => resolve(event.data));
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() => reject(new Error(event.message)));
    };
  });

export interface SnapshotResult {
  path: string;
  method: "backup" | "vacuum_into";
  durationMs: number;
  createdAt: string;
  backupError?: string;
}

/**
 * Copies `sourcePath` (opened read-only) to `<dir>/snapshot-<pid>.sqlite`:
 * the copy is written to a `.tmp` file and renamed into place, then
 * `latest.sqlite` is repointed and dead instances' files are cleaned up.
 */
export const createSnapshot = async (
  sourcePath: string,
  { dir, timeoutMs }: { dir: string; timeoutMs: number },
): Promise<SnapshotResult> => {
  const finalPath = snapshotPathFor(dir, Deno.pid);
  const tmpPath = `${finalPath}.tmp`;
  // Message history: keep it private even if the directory is shared.
  Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const started = Date.now();
  let out: SnapshotWorkerOutput;
  try {
    out = await runWorker({ sourcePath, tmpPath }, timeoutMs);
  } catch (error) {
    try {
      Deno.removeSync(tmpPath);
    } catch {
      // not present
    }
    throw error;
  }
  if (!out.ok) throw new Error(out.error);

  // Connections still open on the previous file keep reading its inode.
  Deno.chmodSync(tmpPath, 0o600);
  Deno.renameSync(tmpPath, finalPath);
  pointLatestAt(dir, finalPath);
  cleanStaleSnapshots(dir);

  return {
    path: finalPath,
    method: out.method,
    durationMs: Date.now() - started,
    createdAt: new Date(started).toISOString(),
    ...(out.backupError ? { backupError: out.backupError } : {}),
  };
};
