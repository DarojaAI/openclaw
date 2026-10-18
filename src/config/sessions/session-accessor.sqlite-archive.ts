import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { syncDirectoryBestEffortSync } from "../../infra/directory-durability.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "./archive-compression.js";
import { formatSessionArchiveTimestamp, type SessionArchiveReason } from "./artifacts.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";

export type SessionStateDeleteSnapshot = {
  acpParentStreamEventCount: number;
  generation: string | null;
  lastSeq: number | null;
  sessionUpdatedAt: number | null;
  trajectoryLastSeq: number | null;
  transcriptUpdatedAt: number | null;
};

export type SessionStateDeletePlan = {
  agentId: string;
  archiveDirectory: string;
  archiveTranscript: boolean;
  databasePath: string;
  reason: "deleted" | "reset";
  sessionId: string;
  snapshot: SessionStateDeleteSnapshot;
};

export type MaterializedSessionStateDeletePlan = SessionStateDeletePlan & {
  archivedTranscript: SessionLifecycleArchivedTranscript | null;
};

export type TranscriptArchiveWorkerPlan = Pick<
  SessionStateDeletePlan,
  "agentId" | "archiveDirectory" | "databasePath" | "reason" | "sessionId" | "snapshot"
>;

export type TranscriptArchiveWorkerResult = {
  archivedPath: string | null;
  sessionId: string;
};

export type TranscriptArchiveWorkerMessage = {
  type: "done";
  results: TranscriptArchiveWorkerResult[];
};

export function sqliteSessionStateDeleteSnapshotsEqual(
  left: SessionStateDeleteSnapshot,
  right: SessionStateDeleteSnapshot,
): boolean {
  return (
    left.acpParentStreamEventCount === right.acpParentStreamEventCount &&
    left.generation === right.generation &&
    left.lastSeq === right.lastSeq &&
    left.sessionUpdatedAt === right.sessionUpdatedAt &&
    left.trajectoryLastSeq === right.trajectoryLastSeq &&
    left.transcriptUpdatedAt === right.transcriptUpdatedAt
  );
}

function resolveSqliteTranscriptArchivePath(params: {
  archiveDirectory: string;
  reason: SessionArchiveReason;
  sessionId: string;
  nowMs?: number;
}): string {
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const archivePath = path.resolve(
    archiveDirectory,
    `${params.sessionId}.jsonl.${params.reason}.${formatSessionArchiveTimestamp(params.nowMs)}`,
  );
  if (path.dirname(archivePath) !== archiveDirectory) {
    throw new Error(`Cannot archive SQLite transcript outside ${archiveDirectory}`);
  }
  return archivePath;
}

function findMatchingSqliteTranscriptArchive(params: {
  archiveDirectory: string;
  content: string;
  reason: SessionArchiveReason;
  sessionId: string;
}): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(params.archiveDirectory);
  } catch {
    return null;
  }
  const prefix = `${params.sessionId}.jsonl.${params.reason}.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || entry.endsWith(".tmp")) {
      continue;
    }
    const archivePath = path.join(params.archiveDirectory, entry);
    const compressed = entry.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX);
    try {
      const stat = fs.statSync(archivePath);
      if (!stat.isFile()) {
        continue;
      }
      if (!compressed && stat.size !== Buffer.byteLength(params.content, "utf8")) {
        continue;
      }
      if (readSessionArchiveContentSync(archivePath) === params.content) {
        return archivePath;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Writes or reuses a transcript archive and returns its durable path. */
export function writeTranscriptArchive(params: {
  archiveDirectory: string;
  content: string;
  reason: SessionArchiveReason;
  sessionId: string;
}): string {
  fs.mkdirSync(params.archiveDirectory, { recursive: true });
  const existing = findMatchingSqliteTranscriptArchive(params);
  if (existing) {
    return existing;
  }
  // Archives are the long-lived cold tier; compress when the runtime can so
  // keep-forever retention stays cheap. Plain JSONL is the Bun/older fallback.
  const encoded = encodeSessionArchiveContent(params.content);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const archivePath = `${resolveSqliteTranscriptArchivePath({
      archiveDirectory: params.archiveDirectory,
      reason: params.reason,
      sessionId: params.sessionId,
      nowMs: Date.now() + attempt,
    })}${encoded.suffix}`;
    if (fs.existsSync(archivePath)) {
      continue;
    }
    const tempPath = `${archivePath}.${randomUUID()}.tmp`;
    try {
      writeDurableFileExclusive(tempPath, encoded.bytes);
      fs.renameSync(tempPath, archivePath);
      syncDirectoryBestEffortSync(params.archiveDirectory);
      // Full readback is bounded by the same single-generation content held by
      // this Worker (Node string limits cap both); a partial
      // or corrupt archive must fail here, before any rows are reclaimed.
      if (readSessionArchiveContentSync(archivePath) !== params.content) {
        fs.rmSync(archivePath, { force: true });
        throw new Error(`SQLite transcript archive verification failed for ${params.sessionId}`);
      }
      return archivePath;
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      if ((error as { code?: unknown })?.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not create SQLite transcript archive for ${params.sessionId}`);
}

// Windows rejects fsync on read-only handles, so keep the exclusive writable
// descriptor open through both the write and durability boundary.
function writeDurableFileExclusive(filePath: string, content: Buffer): void {
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function resolveSqliteTranscriptArchiveWorkerUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(
      path.join(distRoot, "config", "sessions", "session-accessor.sqlite-archive.worker.js"),
    );
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./session-accessor.sqlite-archive.worker${extension}`, currentModuleUrl);
}

function resolveSourceWorkerExecArgv(): string[] {
  // Node 22 can strip the .ts entrypoint itself, but `--import tsx` does not
  // register tsx's ESM resolver inside a Worker. Explicitly register the
  // supported programmatic API so source-tree .js specifiers map back to .ts.
  // Built .js workers do not use this development/test-only preload.
  const tsxApiUrl = import.meta.resolve("tsx/esm/api");
  const registerTsx = `import { register } from ${JSON.stringify(tsxApiUrl)}; register();`;
  return ["--import", `data:text/javascript,${encodeURIComponent(registerTsx)}`];
}

function spawnSqliteTranscriptArchiveWorker(
  plans: readonly TranscriptArchiveWorkerPlan[],
  options: {
    timeoutMs?: number;
    workerUrl?: URL;
  } = {},
): Promise<TranscriptArchiveWorkerResult[]> {
  const workerUrl = options.workerUrl ?? resolveSqliteTranscriptArchiveWorkerUrl();
  const timeoutMs = options.timeoutMs ?? SQLITE_ARCHIVE_WORKER_TIMEOUT_MS;
  let worker: Worker;
  try {
    const sourceWorkerExecArgv = workerUrl.pathname.endsWith(".ts")
      ? resolveSourceWorkerExecArgv()
      : undefined;
    worker = new Worker(workerUrl, {
      workerData: { type: "sqlite-transcript-archive-v1", plans },
      execArgv: sourceWorkerExecArgv,
    });
  } catch (error) {
    return Promise.reject(toStringifiedError(error));
  }

  const { promise, resolve, reject } = Promise.withResolvers<TranscriptArchiveWorkerResult[]>();
  let results: TranscriptArchiveWorkerResult[] | undefined;
  let workerError: Error | undefined;
  let settled = false;
  // One worker services the whole lifecycle-archive queue. A worker stuck in
  // native SQLite/fsync never answers the heap sampler (the 2026-10-08 prod
  // RSS incident's "workerMemoryMissing ... pending" signature) and never
  // emits message/exit, so without a settlement race every later archive
  // plan would queue behind it forever. Terminate the hung isolate and
  // settle deterministically so the queue slot frees.
  const settle = (finish: () => void, terminate: boolean) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    worker.removeAllListeners();
    if (terminate) {
      void worker.terminate().catch(() => undefined);
    }
    finish();
  };
  const timer = setTimeout(() => {
    settle(
      () => reject(new Error(`SQLite transcript archive worker timed out after ${timeoutMs}ms`)),
      true,
    );
  }, timeoutMs);
  timer.unref?.();
  worker.on("message", (message: TranscriptArchiveWorkerMessage) => {
    results = message.results;
  });
  worker.on("error", (error) => {
    // An uncaught Worker error is followed by exit. Wait for that event so
    // callers never race the Worker's SQLite/file handles on Windows.
    workerError = toStringifiedError(error);
  });
  worker.once("exit", (code) => {
    if (workerError) {
      settle(() => reject(workerError as Error), false);
      return;
    }
    if (code !== 0) {
      settle(
        () => reject(new Error(`SQLite transcript archive worker exited with code ${code}`)),
        false,
      );
      return;
    }
    if (!results) {
      settle(
        () => reject(new Error("SQLite transcript archive worker exited without results")),
        false,
      );
      return;
    }
    settle(() => resolve(results as TranscriptArchiveWorkerResult[]), false);
  });
  return promise;
}

// Serialize lifecycle archive Workers so this path cannot multiply
// whole-buffer usage across several Worker heaps at once.
const sqliteTranscriptArchiveWorkerQueue = new KeyedAsyncQueue();
const SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY = "lifecycle-archive";
// Upper bound on archive plans accepted but not yet settled. Every pending
// entry keeps its worker isolate and transcript snapshot alive outside the
// host V8 heap; a wedged worker must bound admissions instead of accumulating.
export const SQLITE_ARCHIVE_QUEUE_MAX_PLANS = 64;
export const SQLITE_ARCHIVE_WORKER_TIMEOUT_MS = 120_000;
let sqliteTranscriptArchiveQueuePlans = 0;

function runSqliteTranscriptArchiveWorker(
  plans: readonly TranscriptArchiveWorkerPlan[],
  options: {
    timeoutMs?: number;
    queueMaxPlans?: number;
    workerUrl?: URL;
  } = {},
): Promise<TranscriptArchiveWorkerResult[]> {
  const queueMaxPlans = options.queueMaxPlans ?? SQLITE_ARCHIVE_QUEUE_MAX_PLANS;
  if (sqliteTranscriptArchiveQueuePlans + plans.length > queueMaxPlans) {
    return Promise.reject(
      new Error(`SQLite transcript archive queue is full (${queueMaxPlans} plans)`),
    );
  }
  sqliteTranscriptArchiveQueuePlans += plans.length;
  return sqliteTranscriptArchiveWorkerQueue.enqueue(
    SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY,
    () => spawnSqliteTranscriptArchiveWorker(plans, options),
    {
      onSettle: () => {
        sqliteTranscriptArchiveQueuePlans = Math.max(
          0,
          sqliteTranscriptArchiveQueuePlans - plans.length,
        );
      },
    },
  );
}

// Runs duplicate probing, archive write, rename, fsync, and readback outside
// SQLite write transactions and off the gateway event loop. The lifecycle
// Worker queue and per-call dedupe prevent concurrent whole-buffer spikes
// within this path.
export async function materializeSessionStateDeletePlans(
  plans: readonly SessionStateDeletePlan[],
  options: {
    archiveWorkerTimeoutMs?: number;
    archiveQueueMaxPlans?: number;
    archiveWorkerUrl?: URL;
  } = {},
): Promise<MaterializedSessionStateDeletePlan[]> {
  const deduped = dedupeSqliteSessionStateDeletePlans(plans);
  const archivePlans = deduped.filter((plan) => plan.archiveTranscript);
  const workerResults =
    archivePlans.length > 0
      ? await runSqliteTranscriptArchiveWorker(archivePlans, {
          timeoutMs: options.archiveWorkerTimeoutMs,
          queueMaxPlans: options.archiveQueueMaxPlans,
          ...(options.archiveWorkerUrl ? { workerUrl: options.archiveWorkerUrl } : {}),
        })
      : [];
  const resultBySessionId = new Map(workerResults.map((result) => [result.sessionId, result]));

  return deduped.map((plan) => {
    if (!plan.archiveTranscript) {
      return Object.assign({}, plan, { archivedTranscript: null });
    }
    const result = resultBySessionId.get(plan.sessionId);
    if (!result) {
      throw new Error(`SQLite transcript archive worker omitted ${plan.sessionId}`);
    }
    const archivedTranscript = result.archivedPath
      ? {
          archivedPath: result.archivedPath,
          sourcePath: path.join(plan.archiveDirectory, `${plan.sessionId}.jsonl`),
        }
      : null;
    return Object.assign({}, plan, { archivedTranscript });
  });
}

// Multiple removed entries can point at one transcript session. If any owner
// asked to keep an archive, the shared row gets exported once.
function dedupeSqliteSessionStateDeletePlans(
  plans: readonly SessionStateDeletePlan[],
): SessionStateDeletePlan[] {
  const deduped = new Map<string, SessionStateDeletePlan>();
  for (const plan of plans) {
    const existing = deduped.get(plan.sessionId);
    if (!existing) {
      deduped.set(plan.sessionId, plan);
      continue;
    }
    if (
      existing.agentId !== plan.agentId ||
      existing.archiveDirectory !== plan.archiveDirectory ||
      existing.databasePath !== plan.databasePath ||
      existing.reason !== plan.reason ||
      !sqliteSessionStateDeleteSnapshotsEqual(existing.snapshot, plan.snapshot)
    ) {
      throw new Error(`Conflicting SQLite transcript archive plans for ${plan.sessionId}`);
    }
    if (!existing.archiveTranscript && plan.archiveTranscript) {
      deduped.set(plan.sessionId, { ...existing, archiveTranscript: true });
    }
  }
  return [...deduped.values()];
}
