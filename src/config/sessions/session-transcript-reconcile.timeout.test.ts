// Session transcript reconcile worker settlement coverage: a reconcile worker
// stuck in native SQLite must be terminated within the settlement budget so
// the scheduled reconcile owner cannot wedge gateway startup (the 2026-10-08
// prod RSS incident's stall -> ownership wedge -> silent outage sequence).
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";

const hangWorkerUrl = new URL(
  "./test-support/sqlite-worker-hang.fixture.worker.mjs",
  import.meta.url,
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function hangWorkerFactory() {
  return vi.fn(() => new Worker(hangWorkerUrl, { workerData: {} }));
}

describe("session transcript reconcile worker settlement", () => {
  let stateDir: string;
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-reconcile-timeout-");
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "reconcile-timeout-session",
      sessionKey: "agent:main:reconcile-timeout-session",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  async function seedDirtyProjection(): Promise<void> {
    // A branch rewind marks the projection dirty (needs_rebuild = 1) so the
    // reconcile preflight spawns its worker instead of short-circuiting.
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "root", parentId: null, message: { role: "user", content: "root" } },
        {
          eventId: "inactive",
          parentId: "root",
          message: { role: "assistant", content: "inactive" },
        },
        { eventId: "active", parentId: "root", message: { role: "assistant", content: "active" } },
      ],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const row = database.db
      .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
      .get(scope.sessionId) as { needs_rebuild: number } | undefined;
    expect(row).toEqual({ needs_rebuild: 1 });
  }

  it("terminates a wedged reconcile worker after the settlement timeout", async () => {
    await seedDirtyProjection();
    const createWorker = hangWorkerFactory();
    await expect(
      reconcileSessionTranscriptIndexes({
        agentId: scope.agentId,
        createWorker,
        env: scope.env,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out after 200ms/);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("does not let a wedged worker wedge the scheduled reconcile owner", async () => {
    await seedDirtyProjection();
    startSessionTranscriptIndexReconcile({
      agentId: scope.agentId,
      createWorker: hangWorkerFactory(),
      env: scope.env,
      timeoutMs: 150,
    });
    // A wedged run used to hold the owner forever; with the settlement budget
    // it fails, logs, and relinquishes the owner so later writes can reschedule.
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });
    expect(
      isSessionTranscriptIndexReconcileRunning({ agentId: scope.agentId, env: scope.env }),
    ).toBe(false);
  });
});
