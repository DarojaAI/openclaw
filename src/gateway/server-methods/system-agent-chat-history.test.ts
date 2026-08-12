import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { appendTranscriptTurn } from "../../system-agent/transcript-store.js";
import {
  appendSystemAgentRecoveryHistory,
  persistSystemAgentEngineHistory,
  setSystemAgentRecoveryHistory,
  systemAgentChatHistoryHandler,
} from "./system-agent-chat-history.js";
import { runSystemAgentGatewayTask } from "./system-agent-gateway-queue.js";
import { getSystemAgentSessionQueue } from "./system-agent-session-queue.js";
import type { GatewayClient } from "./types.js";

const turns = [
  { role: "user" as const, text: "one", at: 1 },
  { role: "assistant" as const, text: "two", at: 2 },
];

const transcriptStoreMocks = vi.hoisted(() => ({
  appendTranscriptTurn: vi.fn(),
  readTranscriptTail: vi.fn(),
}));

vi.mock("../../system-agent/transcript-store.js", () => ({
  appendTranscriptTurn: transcriptStoreMocks.appendTranscriptTurn,
  readTranscriptTail: transcriptStoreMocks.readTranscriptTail,
}));

const ownerClient = {
  connId: "conn-owner",
  connect: { device: { id: "device-owner" } },
} as GatewayClient;

function makeInvocation(params: {
  sessionId?: string;
  limit?: number;
  client?: GatewayClient;
  activeWizardStep?: ReturnType<typeof vi.fn>;
}) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const activeWizardStep = params.activeWizardStep ?? vi.fn().mockResolvedValue(undefined);
  const session = {
    ownerKey: "device:device-owner",
    engine: {
      activeWizardStep,
    },
    lastUsedAt: 1,
  };
  setSystemAgentRecoveryHistory(session.engine, turns);
  const context = {
    systemAgentSessions: new Map(params.sessionId ? [[params.sessionId, session]] : []),
  };
  const options = {
    params: {
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
    },
    client: params.client ?? ownerClient,
    context,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  } as never;
  return { activeWizardStep, calls, context, options, session };
}

describe("openclaw.chat.history wizard recovery", () => {
  beforeEach(() => {
    transcriptStoreMocks.appendTranscriptTurn.mockReset();
    transcriptStoreMocks.readTranscriptTail.mockReset().mockReturnValue(turns);
  });

  it("keeps accepted action metadata on live recovery turns only", () => {
    const wizardAction = {
      kind: "cancel" as const,
    };
    const recoveryTurns = persistSystemAgentEngineHistory(
      {
        historySince: () => [
          { role: "user", text: "Cancel" },
          { role: "assistant", text: "Twitch setup cancelled." },
        ],
      },
      0,
      { wizardAction, wizardActionAccepted: true },
    );

    expect(recoveryTurns).toEqual([
      expect.objectContaining({
        role: "user",
        wizardAction,
      }),
      expect.objectContaining({
        role: "assistant",
      }),
    ]);
    expect(vi.mocked(appendTranscriptTurn).mock.calls.map(([turn]) => turn)).toEqual([
      expect.objectContaining({ role: "user", text: "Cancel" }),
      expect.objectContaining({ role: "assistant", text: "Twitch setup cancelled." }),
    ]);
    for (const [turn] of vi.mocked(appendTranscriptTurn).mock.calls) {
      expect(turn).not.toHaveProperty("wizardAction");
    }
  });

  it("omits action metadata when the engine rejects the typed answer", () => {
    persistSystemAgentEngineHistory(
      {
        historySince: () => [
          { role: "user", text: "Invalid value" },
          { role: "assistant", text: "Choose again." },
        ],
      },
      0,
      {
        wizardAction: { kind: "answer", prompt: "Port" },
        wizardActionAccepted: false,
      },
    );

    expect(vi.mocked(appendTranscriptTurn)).toHaveBeenCalledTimes(2);
    for (const [turn] of vi.mocked(appendTranscriptTurn).mock.calls) {
      expect(turn).not.toHaveProperty("wizardAction");
    }
  });

  it("returns an active wizard only to its bound owner", async () => {
    const activeWizardStep = vi.fn().mockResolvedValue({
      id: "secret",
      type: "text",
      message: "Bot token",
      sensitive: true,
    });
    const owner = makeInvocation({ sessionId: "recover-session", activeWizardStep });

    await systemAgentChatHistoryHandler(owner.options);

    expect(owner.calls).toEqual([
      {
        ok: true,
        payload: {
          turns,
          activeWizard: {
            sessionId: "recover-session",
            step: {
              id: "secret",
              type: "text",
              message: "Bot token",
              sensitive: true,
            },
          },
        },
        error: undefined,
      },
    ]);
    expect(activeWizardStep).toHaveBeenCalledOnce();
    expect(owner.session.lastUsedAt).toBeGreaterThan(1);
    const foreign = makeInvocation({
      sessionId: "recover-session",
      client: {
        connId: "conn-foreign",
        connect: { device: { id: "device-foreign" } },
      } as GatewayClient,
      activeWizardStep,
    });

    await systemAgentChatHistoryHandler(foreign.options);

    expect(foreign.calls).toEqual([
      {
        ok: true,
        payload: { turns },
        error: undefined,
      },
    ]);
    expect(activeWizardStep).toHaveBeenCalledOnce();
    expect(foreign.session.lastUsedAt).toBe(1);
  });

  it("falls back to the global audit history after a Gateway reload", async () => {
    const invocation = makeInvocation({ sessionId: "recover-session" });
    invocation.context.systemAgentSessions.clear();

    await systemAgentChatHistoryHandler(invocation.options);

    expect(transcriptStoreMocks.readTranscriptTail).toHaveBeenCalledWith(100);
    expect(invocation.activeWizardStep).not.toHaveBeenCalled();
    expect(invocation.calls).toEqual([
      {
        ok: true,
        payload: { turns },
        error: undefined,
      },
    ]);
  });

  it("bounds live recovery turns to the history protocol maximum", async () => {
    const invocation = makeInvocation({ sessionId: "recover-session", limit: 500 });
    setSystemAgentRecoveryHistory(
      invocation.session.engine,
      Array.from({ length: 500 }, (_, index) => ({
        role: "assistant" as const,
        text: `old-${index}`,
        at: index,
      })),
    );
    appendSystemAgentRecoveryHistory(invocation.session.engine, [
      { role: "user", text: "new question", at: 500 },
      { role: "assistant", text: "new reply", at: 501 },
    ]);

    await systemAgentChatHistoryHandler(invocation.options);

    const recovered = (
      invocation.calls[0]?.payload as { turns?: Array<{ text: string }> } | undefined
    )?.turns;
    expect(recovered).toHaveLength(500);
    expect(recovered?.[0]?.text).toBe("old-2");
    expect(recovered?.slice(-2).map((turn) => turn.text)).toEqual(["new question", "new reply"]);
  });

  it("waits for the session queue before reading the recovery transcript", async () => {
    const turnStarted = createDeferred();
    const releaseTurn = createDeferred();
    const invocation = makeInvocation({ sessionId: "recover-session" });
    const turn = getSystemAgentSessionQueue(invocation.context.systemAgentSessions).enqueue(
      "recover-session",
      async () => {
        turnStarted.resolve();
        await releaseTurn.promise;
        setSystemAgentRecoveryHistory(invocation.session.engine, [
          { role: "user", text: "committed question", at: 2 },
          { role: "assistant", text: "committed reply", at: 3 },
        ]);
      },
    );
    await turnStarted.promise;

    const history = systemAgentChatHistoryHandler(invocation.options);
    await Promise.resolve();
    const callsBeforeRelease = [...invocation.calls];
    releaseTurn.resolve();
    await Promise.all([turn, history]);

    expect(callsBeforeRelease).toEqual([]);
    expect(invocation.calls).toEqual([
      {
        ok: true,
        payload: {
          turns: [
            { role: "user", text: "committed question", at: 2 },
            { role: "assistant", text: "committed reply", at: 3 },
          ],
        },
        error: undefined,
      },
    ]);
  });

  it("waits for the global Gateway queue before recovering a session", async () => {
    const taskStarted = createDeferred();
    const releaseTask = createDeferred();
    const invocation = makeInvocation({ sessionId: "recover-session" });
    const globalTask = runSystemAgentGatewayTask(async () => {
      taskStarted.resolve();
      await releaseTask.promise;
    });
    await taskStarted.promise;

    const history = systemAgentChatHistoryHandler(invocation.options);
    await Promise.resolve();
    expect(invocation.calls).toEqual([]);

    releaseTask.resolve();
    await Promise.all([globalTask, history]);

    expect(invocation.calls).toEqual([
      {
        ok: true,
        payload: { turns },
        error: undefined,
      },
    ]);
  });

  it("does not read a predecessor replaced under the same session id", async () => {
    const taskStarted = createDeferred();
    const releaseTask = createDeferred();
    const invocation = makeInvocation({ sessionId: "recover-session" });
    const globalTask = runSystemAgentGatewayTask(async () => {
      taskStarted.resolve();
      await releaseTask.promise;
    });
    await taskStarted.promise;

    const history = systemAgentChatHistoryHandler(invocation.options);
    const replacementActiveWizardStep = vi.fn().mockResolvedValue(undefined);
    invocation.context.systemAgentSessions.set("recover-session", {
      ownerKey: invocation.session.ownerKey,
      engine: { activeWizardStep: replacementActiveWizardStep },
      lastUsedAt: 1,
    });
    releaseTask.resolve();
    await Promise.all([globalTask, history]);

    expect(invocation.activeWizardStep).not.toHaveBeenCalled();
    expect(replacementActiveWizardStep).not.toHaveBeenCalled();
    expect(invocation.calls).toEqual([
      {
        ok: true,
        payload: { turns },
        error: undefined,
      },
    ]);
  });
});
