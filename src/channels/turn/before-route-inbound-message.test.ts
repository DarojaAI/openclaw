// before_route_inbound_message (preflight-v1) — gate exit-code mapping, arg
// building, no-op degradation, and kernel wiring.
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const gateScript = fileURLToPath(import.meta.url);
import {
  BEFORE_ROUTE_INBOUND_MESSAGE_HOOK,
  PREFLIGHT_GATE_EXIT_ALLOW,
  PREFLIGHT_GATE_EXIT_CONFIG_ERROR,
  PREFLIGHT_GATE_EXIT_REJECT,
  buildPreflightGateEvaluateArgs,
  classifyPreflightGateExit,
  createPreflightGateClient,
  resolveDefaultPreflightEventLog,
  resolvePreflightGatePath,
  resolveTenantContextFromEnv,
  runBeforeRouteInboundMessage,
} from "./before-route-inbound-message.js";
import type { PreflightGateSpawn } from "./preflight-gate-contract.js";
import { runChannelTurn } from "./run-channel-turn.js";

const ALLOW_EVENT = JSON.stringify({
  event: "preflight.decision.v1",
  timestamp: "2026-10-02T19:23:30Z",
  agentId: "daroja-lawyer-agent",
  actor: "@example-operator-0001",
  decision: "allow",
  reason: "actor-known",
  principalKnown: true,
  tenant: "skipped",
  consent: "ok",
  posture: "ok",
});

const REJECT_EVENT = JSON.stringify({
  event: "preflight.decision.v1",
  timestamp: "2026-10-02T19:23:30Z",
  agentId: "daroja-lawyer-agent",
  actor: "@example-operator-0001",
  capability: "external_send",
  decision: "reject",
  reason: "consent-revoked",
  principalKnown: true,
  tenant: "skipped",
  consent: "revoked",
  posture: "ok",
});

function stubSpawn(options: { exitCode: number; stdout?: string; stderr?: string }) {
  return vi.fn<PreflightGateSpawn>(async () => ({
    exitCode: options.exitCode,
    stdout: options.stdout ?? "",
    stderr: options.stderr ?? "",
  }));
}

describe("preflight gate exit-code classification (contract: 0/1/2, non-zero blocks)", () => {
  it("classifies the three contract exit codes", () => {
    expect(classifyPreflightGateExit(PREFLIGHT_GATE_EXIT_ALLOW)).toBe("allow");
    expect(classifyPreflightGateExit(PREFLIGHT_GATE_EXIT_REJECT)).toBe("reject");
    expect(classifyPreflightGateExit(PREFLIGHT_GATE_EXIT_CONFIG_ERROR)).toBe("config-error");
  });

  it("treats any other non-zero exit as a block (config-error class)", () => {
    expect(classifyPreflightGateExit(3)).toBe("config-error");
    expect(classifyPreflightGateExit(127)).toBe("config-error");
  });
});

describe("buildPreflightGateEvaluateArgs", () => {
  it("emits the contract evaluate wire shape", () => {
    const args = buildPreflightGateEvaluateArgs({
      actor: "@example-operator-0001",
      agent: "daroja-lawyer-agent",
      capability: "draft_redline",
      route: "legal_redline",
      tenant: { counterpartyId: "cp-1", clientId: "client-1", projectId: "proj-1" },
      eventLog: "/var/log/preflight.jsonl",
    });
    expect(args).toEqual([
      "evaluate",
      "--actor",
      "@example-operator-0001",
      "--agent",
      "daroja-lawyer-agent",
      "--capability",
      "draft_redline",
      "--route",
      "legal_redline",
      "--counterparty-id",
      "cp-1",
      "--client-id",
      "client-1",
      "--project-id",
      "proj-1",
      "--event-log",
      "/var/log/preflight.jsonl",
    ]);
  });

  it("supports the tenant JWT path and registry overrides", () => {
    const args = buildPreflightGateEvaluateArgs({
      actor: "u-1",
      agent: "a-1",
      tenant: { jwt: "j.w.t", audience: "tenancy.example.internal" },
      consentFile: "/etc/daroja/preflight/consent.json",
      postureFile: "/etc/daroja/preflight/posture.json",
      principals: "/etc/daroja/preflight/principals.json",
    });
    expect(args).toContain("--tenant-jwt");
    expect(args).toContain("j.w.t");
    expect(args).toContain("--audience");
    expect(args).toContain("tenancy.example.internal");
    expect(args).toContain("--consent-file");
    expect(args).toContain("--posture-file");
    expect(args).toContain("--principals");
  });

  it("omits empty context fields", () => {
    const args = buildPreflightGateEvaluateArgs({ actor: "u-1" });
    expect(args).toEqual(["evaluate", "--actor", "u-1"]);
  });
});

describe("createPreflightGateClient", () => {
  it("is unconfigured when the gate script does not exist", () => {
    const client = createPreflightGateClient({ gatePath: "/nonexistent/preflight-gate.py" });
    expect(client.configured).toBe(false);
  });

  it("invokes the gate script and parses the stdout envelope", async () => {
    const spawn = stubSpawn({ exitCode: 0, stdout: `${ALLOW_EVENT}\n` });
    const client = createPreflightGateClient({ gatePath: gateScript, spawn });
    expect(client.configured).toBe(true);
    const outcome = await client.invoke({ actor: "@example-operator-0001", agent: "agent" });
    expect(outcome).toMatchObject({ exitCode: 0, decision: "allow" });
    expect(outcome.event?.reason).toBe("actor-known");
    expect(outcome.event?.consent).toBe("ok");
    expect(spawn).toHaveBeenCalledWith([
      gateScript,
      "evaluate",
      "--actor",
      "@example-operator-0001",
      "--agent",
      "agent",
    ]);
  });

  it("maps reject stdout and exit 1", async () => {
    const client = createPreflightGateClient({
      gatePath: gateScript,
      spawn: stubSpawn({ exitCode: 1, stdout: `${REJECT_EVENT}\n` }),
    });
    const outcome = await client.invoke({ actor: "u", agent: "a", capability: "external_send" });
    expect(outcome).toMatchObject({ exitCode: 1, decision: "reject" });
    expect(outcome.event?.reason).toBe("consent-revoked");
  });

  it("maps config errors to exit 2 without requiring an event", async () => {
    const client = createPreflightGateClient({
      gatePath: gateScript,
      spawn: stubSpawn({ exitCode: 2, stderr: "registry-unavailable" }),
    });
    const outcome = await client.invoke({ actor: "u", agent: "a" });
    expect(outcome).toMatchObject({ exitCode: 2, decision: "config-error", event: null });
  });

  it("does not synthesize an event from non-JSON output", async () => {
    const client = createPreflightGateClient({
      gatePath: gateScript,
      spawn: stubSpawn({ exitCode: 1, stdout: "some diagnostic\nnot json" }),
    });
    const outcome = await client.invoke({ actor: "u", agent: "a" });
    expect(outcome).toMatchObject({ decision: "reject", event: null });
  });
});

describe("environment resolution", () => {
  it("resolves the gate from PREFLIGHT_GATE", () => {
    expect(resolvePreflightGatePath({ PREFLIGHT_GATE: "/opt/daroja/preflight-gate.py" })).toBe(
      "/opt/daroja/preflight-gate.py",
    );
  });

  it("returns null when nothing is configured", () => {
    expect(resolvePreflightGatePath({})).toBeNull();
  });

  it("defaults the event log under ~/.openclaw/preflight/<env>", () => {
    expect(resolveDefaultPreflightEventLog({ NODE_ENV: "production" })).toMatch(
      /\.openclaw[\\/]preflight[\\/]production[\\/]preflight-decisions\.jsonl$/,
    );
    expect(resolveDefaultPreflightEventLog({})).toMatch(/[\\/]development[\\/]/);
  });
});

describe("runBeforeRouteInboundMessage", () => {
  const gateOptions = (spawn: ReturnType<typeof stubSpawn>) => ({
    gate: createPreflightGateClient({ gatePath: gateScript, spawn }),
    actor: "@example-operator-0001",
    agent: "daroja-lawyer-agent",
  });

  it("degrades to a no-op when the gate is unconfigured", async () => {
    const spawn = stubSpawn({ exitCode: 0 });
    const admission = await runBeforeRouteInboundMessage({
      gate: createPreflightGateClient({ gatePath: "/nonexistent/preflight-gate.py", spawn }),
      actor: "u",
    });
    expect(admission).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("proceeds to routing when the gate allows (exit 0)", async () => {
    const spawn = stubSpawn({ exitCode: 0, stdout: `${ALLOW_EVENT}\n` });
    expect(await runBeforeRouteInboundMessage(gateOptions(spawn))).toBeNull();
  });

  it("blocks the invocation on a gate reject (exit 1)", async () => {
    const spawn = stubSpawn({ exitCode: 1, stdout: `${REJECT_EVENT}\n` });
    expect(await runBeforeRouteInboundMessage(gateOptions(spawn))).toEqual({
      kind: "drop",
      reason: "preflight",
    });
  });

  it("blocks with a config reason on exit 2", async () => {
    const spawn = stubSpawn({ exitCode: 2, stderr: "registry-unavailable" });
    expect(await runBeforeRouteInboundMessage(gateOptions(spawn))).toEqual({
      kind: "drop",
      reason: "preflight-config",
    });
  });

  it("forwards TENANT_* facts so a tenancy-wired gate gets the P1 triple (contract conformance)", async () => {
    // Gateway#122: with TENANCY_BROKER_URL wired the gate treats tenant
    // context as mandatory — an invocation without the triple rejects as
    // `tenant-context-missing`, so the runtime must forward it.
    const spawn = stubSpawn({ exitCode: 0, stdout: `${ALLOW_EVENT}\n` });
    vi.stubEnv("TENANT_COUNTERPARTY_ID", "cp-123");
    vi.stubEnv("TENANT_CLIENT_ID", "cl-456");
    vi.stubEnv("TENANT_PROJECT_ID", "pj-789");
    try {
      expect(await runBeforeRouteInboundMessage(gateOptions(spawn))).toBeNull();
      expect(spawn).toHaveBeenCalledTimes(1);
      const args = (spawn.mock.calls[0]?.[0] ?? []) as string[];
      expect(args).toContain("--counterparty-id");
      expect(args[args.indexOf("--counterparty-id") + 1]).toBe("cp-123");
      expect(args[args.indexOf("--client-id") + 1]).toBe("cl-456");
      expect(args[args.indexOf("--project-id") + 1]).toBe("pj-789");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("forwards the tenant JWT path when TENANT_JWT is provisioned", async () => {
    const spawn = stubSpawn({ exitCode: 0, stdout: `${ALLOW_EVENT}\n` });
    vi.stubEnv("TENANT_JWT", "eyJ.abc.sig");
    vi.stubEnv("TENANT_AUDIENCE", "preflight-gate");
    try {
      await runBeforeRouteInboundMessage(gateOptions(spawn));
      const args = (spawn.mock.calls[0]?.[0] ?? []) as string[];
      expect(args[args.indexOf("--tenant-jwt") + 1]).toBe("eyJ.abc.sig");
      expect(args[args.indexOf("--audience") + 1]).toBe("preflight-gate");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("omits every tenant arg when no TENANT_* fact exists (degraded `skipped` semantics)", async () => {
    const spawn = stubSpawn({ exitCode: 0, stdout: `${ALLOW_EVENT}\n` });
    vi.unstubAllEnvs();
    delete process.env.TENANT_COUNTERPARTY_ID;
    delete process.env.TENANT_CLIENT_ID;
    delete process.env.TENANT_PROJECT_ID;
    delete process.env.TENANT_JWT;
    delete process.env.TENANT_AUDIENCE;
    try {
      await runBeforeRouteInboundMessage(gateOptions(spawn));
      const args = (spawn.mock.calls[0]?.[0] ?? []) as string[];
      expect(args).not.toContain("--counterparty-id");
      expect(args).not.toContain("--client-id");
      expect(args).not.toContain("--project-id");
      expect(args).not.toContain("--tenant-jwt");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("resolveTenantContextFromEnv", () => {
  it("returns undefined with no tenant facts", () => {
    expect(resolveTenantContextFromEnv({})).toBeUndefined();
  });

  it("builds the tenant object from provisioned facts only", () => {
    expect(
      resolveTenantContextFromEnv({
        TENANT_COUNTERPARTY_ID: "cp-1",
        TENANT_PROJECT_ID: "pj-3",
      }),
    ).toEqual({ counterpartyId: "cp-1", projectId: "pj-3" });
  });

  it("carries jwt and audience through", () => {
    expect(resolveTenantContextFromEnv({ TENANT_JWT: "t", TENANT_AUDIENCE: "a" })).toEqual({
      jwt: "t",
      audience: "a",
    });
  });
});

describe("before_route_inbound_message kernel wiring", () => {
  function makeAdapter() {
    const resolveTurn = vi.fn<() => Promise<never>>(() => {
      throw new Error("no turn resolver");
    });
    return {
      adapter: {
        ingest: async () => ({ id: "m1", rawText: "hello", textForAgent: "hello" }),
        resolveTurn,
      },
      resolveTurn,
    };
  }

  it("blocks before routing when the gate rejects (exit 1)", async () => {
    const { adapter, resolveTurn } = makeAdapter();
    const result = await runChannelTurn({
      channel: "test",
      raw: {},
      adapter,
      beforeRouteInboundMessage: {
        gate: createPreflightGateClient({
          gatePath: gateScript,
          spawn: stubSpawn({ exitCode: 1, stdout: `${REJECT_EVENT}\n` }),
        }),
        actor: "@example-operator-0001",
        agent: "daroja-lawyer-agent",
      },
    });
    expect(result).toEqual({ admission: { kind: "drop", reason: "preflight" }, dispatched: false });
    expect(resolveTurn).not.toHaveBeenCalled();
  });

  it("routes normally when the gate allows (exit 0)", async () => {
    const { adapter, resolveTurn } = makeAdapter();
    await expect(
      runChannelTurn({
        channel: "test",
        raw: {},
        adapter,
        beforeRouteInboundMessage: {
          gate: createPreflightGateClient({
            gatePath: gateScript,
            spawn: stubSpawn({ exitCode: 0, stdout: `${ALLOW_EVENT}\n` }),
          }),
          actor: "@example-operator-0001",
          agent: "daroja-lawyer-agent",
        },
      }),
    ).rejects.toThrow("no turn resolver");
    expect(resolveTurn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for unconfigured installs (no routing change)", async () => {
    const { adapter, resolveTurn } = makeAdapter();
    await expect(
      runChannelTurn({
        channel: "test",
        raw: {},
        adapter,
        beforeRouteInboundMessage: {
          gate: createPreflightGateClient({ gatePath: "/nonexistent/preflight-gate.py" }),
        },
      }),
    ).rejects.toThrow("no turn resolver");
    expect(resolveTurn).toHaveBeenCalledTimes(1);
  });

  it("does not run the hook when not wired", async () => {
    const { adapter, resolveTurn } = makeAdapter();
    await expect(runChannelTurn({ channel: "test", raw: {}, adapter })).rejects.toThrow(
      "no turn resolver",
    );
    expect(resolveTurn).toHaveBeenCalledTimes(1);
  });
});

describe("hook identity", () => {
  it("exposes the contract hook name", () => {
    expect(BEFORE_ROUTE_INBOUND_MESSAGE_HOOK).toBe("before_route_inbound_message");
  });
});
