// Entitlement for GitHub Unlock: the age-driven transcript archive pass keeps
// the session-history-eviction module under the line-cap ratchet by placing the
// post-archive page reclamation here.
import { readSqliteAutoVacuumReclamationState } from "../../infra/sqlite-wal-reclamation.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import type { SqliteSessionArchivePruningDiagnostics } from "./session-accessor.sqlite-contract.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import { withSqliteSessionDatabase } from "./session-accessor.sqlite-scope.js";
import { reclaimSqliteFreePages } from "./session-history-archive-pruning.js";
import type { SessionHistoryCheckpointGate } from "./session-history-budget-state.js";

const log = createSubsystemLogger("sessions/history-eviction");

export type AgeDrivenReclamationResult = {
  /**
   * True when the store is a legacy `auto_vacuum=NONE` database whose freed
   * pages cannot be reclaimed online. The pass still reports an actionable
   * deferral: Doctor's offline sqlite reclamation owns the header flip plus
   * full `VACUUM` conversion.
   */
  deferredToDoctor: boolean;
};

/**
 * Reclaim freelist pages freed by an age-driven archive pass through the
 * maintenance reclamation lifecycle (checkpoint-gated incremental vacuum).
 * Best-effort: a busy or locked file skips cleanly and the next pass retries;
 * committed archives are never rolled back. Legacy stores that never received
 * the doctor `auto_vacuum=INCREMENTAL` retrofit keep every deleted page in the
 * freelist — incremental vacuum is a no-op for them. Their conversion (header
 * flip plus full `VACUUM`) is owned OFFLINE by Doctor's sqlite reclamation;
 * running a full synchronous VACUUM here would block the foreground writer,
 * so the pass defers with an actionable result instead.
 */
export async function reclaimAgeDrivenArchivePages(
  databaseOptions: OpenClawAgentDatabaseOptions,
  checkpointGate: SessionHistoryCheckpointGate,
): Promise<AgeDrivenReclamationResult> {
  try {
    return await withSqliteSessionPageReclamation(
      databaseOptions,
      async (reclaimPages, assertCurrent, preparedOptions) => {
        const state = await withSqliteSessionDatabase(preparedOptions, (database) =>
          readSqliteAutoVacuumReclamationState(database.db),
        );
        if (state.requiresOfflineDoctorConversion) {
          log.warn(
            "session history page reclamation deferred: legacy auto_vacuum=NONE store needs Doctor's offline SQLite reclamation",
            {
              freePages: state.freePages,
              storePath: databaseOptions.path,
            },
          );
          return { deferredToDoctor: true };
        }
        const pageDiagnostics: SqliteSessionArchivePruningDiagnostics = {
          trigger: "after-eviction",
        };
        checkpointGate.afterNs = process.hrtime.bigint();
        await reclaimSqliteFreePages(preparedOptions, pageDiagnostics, {
          reclaimPages,
          checkpointGate,
          assertCurrent,
        });
        return { deferredToDoctor: false };
      },
    );
  } catch {
    // Best-effort reclamation only; committed archives are never rolled back.
    return { deferredToDoctor: false };
  }
}
