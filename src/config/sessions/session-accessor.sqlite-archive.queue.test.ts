// SQLite transcript archive queue admission and worker settlement coverage:
// a wedged archive worker must time out and free the lifecycle-archive queue
// slot, and admissions must stay bounded while one worker is wedged.
import { describe, expect, it } from "vitest";
import {
  materializeSessionStateDeletePlans,
  type SessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";

const hangWorkerUrl = new URL(
  "./test-support/sqlite-worker-hang.fixture.worker.mjs",
  import.meta.url,
);

function archivePlan(sessionId: string): SessionStateDeletePlan {
  return {
    agentId: "main",
    archiveDirectory: "/tmp/openclaw-issue138-archive-test",
    archiveTranscript: true,
    databasePath: "/tmp/openclaw-issue138-agent.sqlite",
    reason: "deleted",
    sessionId,
    snapshot: {
      acpParentStreamEventCount: 0,
      generation: null,
      lastSeq: null,
      sessionUpdatedAt: null,
      trajectoryLastSeq: null,
      transcriptUpdatedAt: null,
    },
  };
}

describe("SQLite transcript archive worker settlement", () => {
  it("rejects a wedged archive worker after the settlement timeout", async () => {
    await expect(
      materializeSessionStateDeletePlans([archivePlan("settle-timeout")], {
        archiveWorkerUrl: hangWorkerUrl,
        archiveWorkerTimeoutMs: 150,
      }),
    ).rejects.toThrow(/timed out after 150ms/);
  });

  it("bounds archive admissions while a worker is wedged and frees the slot on settlement", async () => {
    const wedgedRun = materializeSessionStateDeletePlans([archivePlan("first")], {
      archiveWorkerUrl: hangWorkerUrl,
      archiveWorkerTimeoutMs: 400,
      archiveQueueMaxPlans: 2,
    });
    // Second call still fits the bound and joins the wedged queue.
    const queuedRun = materializeSessionStateDeletePlans([archivePlan("second")], {
      archiveWorkerUrl: hangWorkerUrl,
      archiveWorkerTimeoutMs: 400,
      archiveQueueMaxPlans: 2,
    });
    // Third call exceeds the bound while the queue has not settled: admission
    // must fail immediately instead of accumulating its plan off-heap.
    await expect(
      materializeSessionStateDeletePlans([archivePlan("third")], {
        archiveWorkerUrl: hangWorkerUrl,
        archiveWorkerTimeoutMs: 400,
        archiveQueueMaxPlans: 2,
      }),
    ).rejects.toThrow(/archive queue is full/);

    // Bounded wait: the settlement timeout terminates each wedged worker.
    await expect(wedgedRun).rejects.toThrow(/timed out after 400ms/);
    await expect(queuedRun).rejects.toThrow(/timed out after 400ms/);

    // The lifecycle-archive slot is free again: the next admission is
    // accepted (no "queue is full") and settles on its own timeout.
    await expect(
      materializeSessionStateDeletePlans([archivePlan("after")], {
        archiveWorkerUrl: hangWorkerUrl,
        archiveWorkerTimeoutMs: 150,
        archiveQueueMaxPlans: 2,
      }),
    ).rejects.toThrow(/timed out after 150ms/);
  });
});
