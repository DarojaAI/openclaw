// Session transcript reconcile worker settlement coverage: a reconcile worker
// stuck in native SQLite must be retired within the settlement budget so the
// scheduled reconcile owner cannot wedge gateway startup (the #176080 worker
// wedge -> ownership stall -> outage class). The first (disk) reconcile worker
// hangs; later lease-release work uses the real worker so cleanup can settle.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";

const hangWorkerUrl = new URL(
  "./test-support/sqlite-worker-hang.fixture.worker.mjs",
  import.meta.url,
);

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const options = { agentId: "main" };
const scope = {
  ...options,
  sessionId: "reconcile-timeout-session",
  sessionKey: "agent:main:reconcile-timeout-session",
};

async function seedDirtyProjection(): Promise<void> {
  await persistSessionTranscriptTurn(scope, {
    messages: [{ eventId: "root", parentId: null, message: { role: "user", content: "root" } }],
    touchSessionEntry: false,
  });
  const database = openOpenClawAgentDatabase(options);
  database.db
    .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
    .run(scope.sessionId);
  const row = database.db
    .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
    .get(scope.sessionId) as { needs_rebuild: number } | undefined;
  expect(row).toEqual({ needs_rebuild: 1 });
}

describe("session transcript reconcile worker settlement", () => {
  it("terminates a wedged reconcile worker after the settlement timeout", async () => {
    const stateDir = tempDirs.make("openclaw-reconcile-timeout-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      setRuntimeConfigSnapshot({});
      try {
        await seedDirtyProjection();
        let reconcileWorkerCreated = false;
        observer.onTask = ({ input }) => {
          if (input.mode === "disk") {
            reconcileWorkerCreated = true;
          }
        };
        let constructions = 0;
        observer.beforeCreate = (filename, workerOptions) => {
          constructions += 1;
          // Wedge the first (disk) worker; lease-release cleanup uses the real
          // worker so the owner can relinquish without wedging.
          if (constructions === 1) {
            return { filename: hangWorkerUrl, options: workerOptions };
          }
          return undefined;
        };
        await expect(
          reconcileSessionTranscriptIndexes({ agentId: "main", timeoutMs: 200 }),
        ).rejects.toThrow(/timed out after 200ms/);
        expect(reconcileWorkerCreated).toBe(true);
      } finally {
        observer.beforeCreate = undefined;
        observer.onTask = undefined;
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        clearRuntimeConfigSnapshot();
      }
    });
  });

  it("does not let a wedged worker wedge the scheduled reconcile owner", async () => {
    const stateDir = tempDirs.make("openclaw-reconcile-timeout-owner-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      setRuntimeConfigSnapshot({});
      try {
        await seedDirtyProjection();
        let constructions = 0;
        observer.beforeCreate = (filename, workerOptions) => {
          constructions += 1;
          // Wedge the first (disk) worker; lease-release cleanup uses the real worker.
          if (constructions === 1) {
            return { filename: hangWorkerUrl, options: workerOptions };
          }
          return undefined;
        };
        startSessionTranscriptIndexReconcile({ agentId: "main", timeoutMs: 150 });
        // A wedged run used to hold the owner forever; with the settlement budget
        // it fails, logs, and relinquishes the owner so later writes can reschedule.
        await waitForSessionTranscriptIndexReconcile(options);
        expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(false);
      } finally {
        observer.beforeCreate = undefined;
        observer.onTask = undefined;
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        clearRuntimeConfigSnapshot();
      }
    });
  });
});
