import type { SqliteWalHealth } from "../../infra/sqlite-wal-checkpoint.js";
import type { SessionEntry } from "./types.js";

export type SessionDiskBudgetSweepResult = {
  totalBytesBefore: number;
  totalBytesAfter: number;
  removedFiles: number;
  removedEntries: number;
  freedBytes: number;
  maxBytes: number;
  highWaterBytes: number;
  overBudget: boolean;
  /**
   * Why this pass stopped short of reclaiming everything it identified:
   * `"checkpoint-incomplete"` defers until a completed WAL checkpoint is
   * observed; `"doctor-retrofit-required"` means a legacy `auto_vacuum=NONE`
   * store must be converted offline by Doctor's sqlite reclamation.
   */
  deferredReason?: "checkpoint-incomplete" | "doctor-retrofit-required";
  checkpoint?: SqliteWalHealth;
  walBytesBefore?: number;
  walBytesAfter?: number;
};

export type SessionUnreferencedArtifactSweepResult = {
  scannedFiles: number;
  removedFiles: number;
  freedBytes: number;
  olderThanMs: number;
};

export type ArchivedSessionEvictionQuery = {
  liveSessionKeys: readonly string[];
  after?: { archivedAt: number; sessionKey: string };
  limit?: number;
  preserveRecentMs?: number | null;
};

export type ArchivedSessionEvictionBatch = {
  candidates: Array<{ archivedAt: number; entry: SessionEntry; sessionKey: string }>;
  cursor?: { archivedAt: number; sessionKey: string };
  exhausted: boolean;
};
