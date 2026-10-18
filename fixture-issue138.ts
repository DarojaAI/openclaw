// Issue #138 diagnosis harness — drives the gateway runtime's session/transcript
// hot paths (sqlite store writes + transcript-index reconcile workers + audit
// events + memory diagnostics) under a sustained "active agent workload" and
// samples RSS / V8 heap / external / arrayBuffers / worker count per cycle.
// Run from repo root: node --import tsx --expose-gc fixture-issue138.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import {
  upsertSessionEntryCore,
  appendTranscriptMessage,
  loadTranscriptEvents,
} from "./src/config/sessions/session-accessor.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  waitForSessionTranscriptIndexReconcile,
} from "./src/config/sessions/session-transcript-reconcile.js";
import { emitDiagnosticMemorySample } from "./src/logging/diagnostic-memory.js";
import { closeOpenClawAgentDatabasesForTest } from "./src/state/openclaw-agent-db.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue138-fixture-"));
const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
const AGENTS = ["main", "ops", "work", "support", "research", "qa"] as const;
const CYCLES = Number(process.env.FIXTURE_CYCLES ?? 120);
const MSG_PER_CYCLE = Number(process.env.FIXTURE_MSGS ?? 8);
const BIG_TEXT_KB = Number(process.env.FIXTURE_TEXT_KB ?? 12);
const SNAPSHOT_INTERVAL = 20;
const consoleOut = (line: string) => process.stdout.write(line + "\n");

function bigText(tag: string, kb: number): string {
  const chunk = `ctx-${tag}-${randomUUID()} `;
  const repeat = Math.max(1, Math.ceil((kb * 1024) / chunk.length));
  return chunk.repeat(repeat).slice(0, kb * 1024);
}

async function main() {
  consoleOut(
    [
      "cycle",
      "rssMB",
      "heapUsedMB",
      "heapTotalMB",
      "externalMB",
      "arrayBuffersMB",
      "heapLimitMB",
      "reconcileRunning",
      "workersActive",
      "sessionsInDb",
      "messagesInDb",
    ].join("\t"),
  );

  let sessionCounter = 0;
  const sessionIds = new Map<string, string>();
  fs.mkdirSync(path.join(stateDir, "agents"), { recursive: true });

  // Warm-up: first cycle creates the DBs and schema; establish a steady baseline.
  for (let cycle = 0; cycle < Math.min(CYCLES, 2); cycle += 1) {
    for (const agentId of AGENTS) {
      const sessionKey = `agent:${agentId}:fixture-cloud`;
      const sessionId = sessionIds.get(agentId) ?? `fixture-session-${agentId}-${cycle}`;
      sessionIds.set(agentId, sessionId);
      const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
      await upsertSessionEntryCore(
        { agentId, env, sessionKey, storePath },
        { sessionId, updatedAt: Date.now(), label: `fixture ${cycle}` },
      );
      for (let m = 0; m < 2; m += 1) {
        await appendTranscriptMessage(
          { agentId, env, sessionKey, sessionId, storePath },
          {
            message: {
              role: m % 2 === 0 ? "user" : "assistant",
              content: bigText(`${agentId}-warm`, BIG_TEXT_KB),
            },
          },
        );
      }
    }
  }

  // Drain the warm-up reconcile so baseline is post-warm-up.
  for (const agentId of AGENTS) {
    await waitForSessionTranscriptIndexReconcile({ agentId, env });
  }

  for (let cycle = 2; cycle < CYCLES; cycle += 1) {
    let written = 0;
    for (const agentId of AGENTS) {
      const sessionKey = `agent:${agentId}:fixture-cloud`;
      let sessionId = sessionIds.get(agentId);
      if (sessionId === undefined || (cycle > 0 && cycle % 40 === 0)) {
        // Rotate: fresh session key to churn entry create + transcript archive.
        sessionCounter += 1;
        sessionId = `fixture-session-${agentId}-${sessionCounter}`;
        sessionIds.set(agentId, sessionId);
      }
      const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
      await upsertSessionEntryCore(
        { agentId, env, sessionKey, storePath },
        { sessionId, updatedAt: Date.now(), label: `fixture cycle ${cycle}` },
      );
      for (let m = 0; m < MSG_PER_CYCLE; m += 1) {
        const kind = m % 3;
        const message =
          kind === 1
            ? {
                role: "user" as const,
                content: bigText(`${agentId}-u${cycle}-${m}`, Math.max(2, BIG_TEXT_KB / 2)),
              }
            : {
                role: "assistant" as const,
                content: [
                  { type: "text" as const, text: bigText(`${agentId}-a${cycle}-${m}`, BIG_TEXT_KB) },
                  ...(kind === 2
                    ? [{ type: "tool_use" as const, name: "bash", input: { command: "echo hi" } }]
                    : []),
                ],
              };
        await appendTranscriptMessage(
          { agentId, env, sessionKey, sessionId, storePath },
          { message },
        );
        written += 1;
      }
    }

    // Let the detached reconcile loop settle every few cycles (mirrors the
    // ownership gate's maintenance cadence), but keep churn overlapping.
    if (cycle % 6 === 0) {
      for (const agentId of AGENTS) {
        await waitForSessionTranscriptIndexReconcile({ agentId, env });
      }
    }

    if (global.gc) global.gc();
    const mu = process.memoryUsage();
    const hs = v8.getHeapStatistics();
    const reconcileRunning = AGENTS.filter((a) =>
      isSessionTranscriptIndexReconcileRunning({ agentId: a, env }),
    ).length;
    const workersActive = (process.getActiveResourcesInfo?.() ?? []).filter((r) =>
      r.includes("Worker"),
    ).length;

    let sessionsInDb = 0;
    let messagesInDb = 0;
    for (const agentId of AGENTS) {
      try {
        const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
        const events = await loadTranscriptEvents({
          agentId,
          env,
          sessionId: sessionIds.get(agentId)!,
          sessionKey: `agent:${agentId}:fixture-cloud`,
          storePath,
        });
        sessionsInDb += events.length > 0 ? 1 : 0;
        messagesInDb += events.filter((e) => e.type === "message").length;
      } catch {
        // Session not yet persisted — fine for metrics.
      }
    }

    consoleOut(
      [
        cycle,
        (mu.rss / 1048576).toFixed(1),
        (mu.heapUsed / 1048576).toFixed(1),
        (mu.heapTotal / 1048576).toFixed(1),
        (mu.external / 1048576).toFixed(1),
        (mu.arrayBuffers / 1048576).toFixed(1),
        (hs.heap_size_limit / 1048576).toFixed(1),
        reconcileRunning,
        workersActive,
        sessionsInDb,
        messagesInDb,
      ].join("\t"),
    );

    if (cycle % SNAPSHOT_INTERVAL === 0 && global.gc) {
      const snap = path.join(stateDir, `heap-${String(cycle).padStart(4, "0")}.heapsnapshot`);
      v8.writeHeapSnapshot(snap);
      consoleOut(`# snapshot ${snap}`);
    }
    emitDiagnosticMemorySample({ env, emitSample: true, writeCriticalBundle: false });
  }

  closeOpenClawAgentDatabasesForTest();

  consoleOut(`# STATE_DIR=${stateDir}`);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
void main().then(
  () => {
    process.exit(0);
  },
  (err) => {
    consoleOut(`# HARNESS_ERROR ${String(err)}`);
    process.exit(1);
  },
);