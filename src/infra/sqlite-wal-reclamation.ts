import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { isPostgresSqlConnection, type EngineConnection } from "./sql-connection.js";
import { runWithSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import type {
  SqliteWalCheckpointMode,
  SqliteWalCheckpointSnapshot,
} from "./sqlite-wal-checkpoint.js";

const VACUUM_UNIT_TARGET_MS = 25;
// Scheduling estimates belong to the native connection lifetime, never persisted store facts.
const vacuumPageBudgets = new WeakMap<DatabaseSync, number>();

export type SqliteWalReclamationOptions = {
  maxPages?: number;
  checkpointMode?: SqliteWalCheckpointMode;
  beforeMutation?: () => void;
  onCommit?: () => void;
  afterCommit?: () => void;
};

export type SqliteWalReclamationResult = {
  checkpointCompleted: boolean;
  checkpoint?: SqliteWalCheckpointSnapshot;
  freePagesBefore: number | null;
  remainingFreePages: number | null;
  checkpointCalls: number;
  checkpointIncomplete: number;
  checkpointMs: number;
  checkpointMaxMs: number;
  queryMs: number;
  vacuumMs: number;
  vacuumPasses: number;
  vacuumPagesRequested: number;
};

export function createSqliteWalReclamationResult(): SqliteWalReclamationResult {
  return {
    checkpointCompleted: false,
    freePagesBefore: null,
    remainingFreePages: null,
    checkpointCalls: 0,
    checkpointIncomplete: 0,
    checkpointMs: 0,
    checkpointMaxMs: 0,
    queryMs: 0,
    vacuumMs: 0,
    vacuumPasses: 0,
    vacuumPagesRequested: 0,
  };
}

/** Physical page accounting for both reclamation and its read-only eligibility probe. */
export function readSqliteFreePageCount(
  database: DatabaseSync,
  diagnostics?: Pick<SqliteWalReclamationResult, "queryMs">,
): number {
  const startedAt = diagnostics ? performance.now() : 0;
  try {
    return Number(
      // sqlite-allow-raw -- Physical page accounting belongs to the WAL owner.
      database.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0,
    );
  } finally {
    if (diagnostics) {
      diagnostics.queryMs += performance.now() - startedAt;
    }
  }
}

export type SqliteAutoVacuumReclamationState = {
  /** `auto_vacuum` pragma mode: 0 NONE, 1 FULL, 2 INCREMENTAL (2 when N/A). */
  autoVacuumMode: number;
  /** Acknowledged freelist page count; 0 when the connection is not a SQLite store. */
  freePages: number;
  /**
   * True when this legacy store keeps every deleted page in the freelist and
   * must be converted (`PRAGMA auto_vacuum = INCREMENTAL; VACUUM;`) by
   * Doctor's OFFLINE sqlite reclamation. Online maintenance must never run
   * that full synchronous VACUUM on the foreground writer path.
   */
  requiresOfflineDoctorConversion: boolean;
};

/**
 * Inspect-only reclamation eligibility. Conversion of a legacy
 * `auto_vacuum=NONE` store is owned by Doctor's offline sqlite reclamation
 * flow (readers and writers drained, temp-space verified), so this function
 * only reports the mode and freelist instead of mutating the store. Online
 * maintenance reclaims freelist pages exclusively through the checkpoint-gated
 * reclaimer on stores already running `auto_vacuum=INCREMENTAL`.
 */
export function readSqliteAutoVacuumReclamationState(
  database: EngineConnection,
): SqliteAutoVacuumReclamationState {
  if (isPostgresSqlConnection(database)) {
    return { autoVacuumMode: 2, freePages: 0, requiresOfflineDoctorConversion: false };
  }
  // PRAGMA returns a bare row object with no static schema; the values are
  // re-validated via Number before use.
  const freeRow =
    // sqlite-allow-raw -- Physical page accounting belongs to the WAL owner.
    // SAFETY: PRAGMA rows are driver objects; only the numeric field is used.
    database.prepare("PRAGMA freelist_count").get() as { freelist_count?: unknown } | undefined;
  const freePages = Number(freeRow?.freelist_count ?? 0);
  // same driver-boundary widening as freelist_count; only the
  // numeric auto_vacuum mode is consumed.
  const vacuumRow =
    // sqlite-allow-raw -- auto_vacuum mode inspection belongs to the WAL owner.
    // SAFETY: only the numeric auto_vacuum mode is read.
    database.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: unknown } | undefined;
  const autoVacuumMode = Number(vacuumRow?.auto_vacuum ?? 0);
  const acknowledgedFreePages = Number.isSafeInteger(freePages) && freePages > 0 ? freePages : 0;
  return {
    autoVacuumMode,
    freePages: acknowledgedFreePages,
    requiresOfflineDoctorConversion: autoVacuumMode !== 2 && acknowledgedFreePages > 0,
  };
}

/** One online unit never waits for readers or adds vacuum frames behind a blocked checkpoint. */
export function reclaimSqliteWalFreePages(
  database: DatabaseSync,
  runCheckpoint: (mode: SqliteWalCheckpointMode) => boolean,
  options: SqliteWalReclamationOptions,
): SqliteWalReclamationResult {
  const result = createSqliteWalReclamationResult();
  const checkpoint = () => {
    options.beforeMutation?.();
    const startedAt = performance.now();
    try {
      const mode = options.checkpointMode ?? "TRUNCATE";
      let completed = runCheckpoint(mode);
      result.checkpointCalls++;
      if (!completed && mode === "TRUNCATE") {
        // Readers can prevent WAL reset after every frame has been copied.
        // Require a fresh complete checkpoint, not an empty WAL file, before
        // adding vacuum frames or letting disk-budget eviction proceed.
        options.beforeMutation?.();
        completed = runCheckpoint("PASSIVE");
        result.checkpointCalls++;
      }
      result.checkpointCompleted = completed;
      result.checkpointIncomplete += Number(!completed);
      return completed;
    } finally {
      const elapsed = performance.now() - startedAt;
      result.checkpointMs += elapsed;
      result.checkpointMaxMs = Math.max(result.checkpointMaxMs, elapsed);
    }
  };
  // PASSIVE never invokes SQLite's busy handler; checkpoint-only ticks need no policy change.
  if (options.maxPages === 0 && options.checkpointMode === "PASSIVE") {
    checkpoint();
    return result;
  }
  return runWithSqliteBusyTimeout(database, 0, () => {
    // A zero page budget is a checkpoint-only pass; vacuum keeps its own cadence.
    if (!checkpoint() || options.maxPages === 0) {
      return result;
    }
    const before = readSqliteFreePageCount(database, result);
    result.freePagesBefore = before;
    result.remainingFreePages = before;
    if (!Number.isSafeInteger(before) || before <= 0) {
      return result;
    }
    const pages = Math.min(vacuumPageBudgets.get(database) ?? 8, before, options.maxPages ?? 512);
    if (!Number.isSafeInteger(pages) || pages <= 0) {
      throw new Error("SQLite page reclamation requires a positive integer page limit");
    }
    const startedAt = performance.now();
    let entered = false;
    let completed = false;
    try {
      runSqliteImmediateTransactionSync(
        database,
        () => {
          entered = true;
          options.beforeMutation?.();
          result.vacuumPasses++;
          result.vacuumPagesRequested += pages;
          // sqlite-allow-raw -- Bound physical maintenance within its admitted synchronous transaction.
          database.exec(`PRAGMA incremental_vacuum(${pages});`);
          options.onCommit?.();
        },
        { busyTimeoutMs: 0, operationLabel: "incremental-vacuum" },
      );
      completed = true;
    } catch (error) {
      if (entered || !isSqliteLockError(error)) {
        throw error;
      }
      return result;
    } finally {
      const elapsedMs = performance.now() - startedAt;
      result.vacuumMs += elapsedMs;
      if (completed) {
        vacuumPageBudgets.set(
          database,
          Math.max(
            1,
            Math.min(
              512,
              pages * 2,
              Math.floor((pages * VACUUM_UNIT_TARGET_MS) / Math.max(elapsedMs, 0.001)),
            ),
          ),
        );
      }
    }
    options.afterCommit?.();
    if (checkpoint()) {
      result.remainingFreePages = readSqliteFreePageCount(database, result);
    }
    return result;
  });
}
