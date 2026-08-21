// pr-gate extension — DarojaAI PR-closeout enforcement.
//
// Implements RFC DarojaAI/.github#33: rejects outbound message(send)
// calls that include a green-claim phrase (e.g. "CI green", "ready
// for review") when no `gh pr checks <n>` has been observed for the
// referenced PR in the current process. Default-allow when the plugin
// is not configured.
import { spawn } from "node:child_process";
import { registerMessageSendingGate } from "openclaw/plugin-sdk/internal-hooks";
import manifest from "./openclaw.plugin.json" with { type: "json" };

type GateConfig = {
  // Green-claim phrases blocked when no `gh pr checks` evidence is present.
  // Defaults ship with the org's PR-verify rule text (RFC #33).
  greenClaimPhrases?: string[];
  // PR references extracted via this regex from message content. Used to
  // pin the gate decision to a specific PR number when present.
  prReferencePattern?: RegExp;
  // Path to the `gh` binary. Default: "gh" (PATH-resolved).
  ghBinary?: string;
  // Time-to-live in ms for a successful `gh pr checks` observation.
  // After this TTL expires without a fresh call, the gate moves back to
  // "needs verification".
  observationTtlMs?: number;
  // When true, log every gate decision to stderr regardless of allow/block.
  verbose?: boolean;
};

type Observation = {
  prNumber: number;
  observedAt: number;
  allChecksPassed: boolean;
};

// Process-local observation cache. The plugin is loaded into the agent
// process so cross-process coordination is not required for v1; the
// observation cache lives in module scope and is reset on process restart.
// A future iteration can move this to a per-session store plus a WIF
// provisioning path for cross-process reads.
const observations = new Map<number, Observation>();

// Default green-claim phrases mirror the AGENTS.md rule text added
// in DarojaAI/darojaai_architect#41 (RFC DarojaAI/.github#33).
const DEFAULT_GREEN_CLAIM_PHRASES = [
  "CI green",
  "ready for review",
  "ready for your approval",
  "expected green",
];

// PR references look like "PR #1410", "pull/1410", "DarojaAI/<repo>#N".
const DEFAULT_PR_REFERENCE_PATTERN = /(?:^|\W)(?:#|pull\/)(\d+)\b/;

function execGh(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    child.on("error", (err) => {
      resolve({ stdout: "", stderr: err.message, code: 1 });
    });
  });
}

async function verifyChecksForPr(prNumber: number, ghBinary: string): Promise<Observation | null> {
  // We don't know the repo from the message alone; require the caller to
  // ladder the env var or rely on gh's own resolution against $GH_REPO.
  const { stdout, code } = await execGh([
    ghBinary,
    "pr",
    "checks",
    String(prNumber),
    "--json",
    "name,state",
  ]);
  if (code !== 0) return null;
  try {
    const rows = JSON.parse(stdout) as Array<{ name: string; state: string }>;
    if (rows.length === 0) return null;
    const allChecksPassed = rows.every((row) =>
      ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(row.state.toUpperCase()),
    );
    return {
      prNumber,
      observedAt: Date.now(),
      allChecksPassed,
    };
  } catch {
    return null;
  }
}

function findPrReferences(content: string, pattern: RegExp): number[] {
  const matches = content.match(new RegExp(pattern.source, "g"));
  if (!matches) return [];
  const prNumbers = new Set<number>();
  for (const match of matches) {
    const digits = match.match(/\d+/);
    if (!digits) continue;
    prNumbers.add(Number(digits[0]));
  }
  return [...prNumbers];
}

function containsGreenClaim(content: string, phrases: string[]): boolean {
  const lower = content.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase.toLowerCase()));
}

async function gateHandler(config: Required<GateConfig>) {
  return async (context: {
    to: string;
    content: string;
    channelId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ allow: true } | { allow: false; reason: string; code?: string }> => {
    if (!containsGreenClaim(context.content, config.greenClaimPhrases)) {
      return { allow: true };
    }

    const prNumbers = findPrReferences(context.content, config.prReferencePattern);
    if (prNumbers.length === 0) {
      return {
        allow: false,
        reason:
          "Green-claim phrase detected in outbound message but no PR reference was found. " +
          "Add a PR number (#N) to the message so the gate can verify checks first.",
        code: "GREEN_CLAIM_NO_PR_REFERENCE",
      };
    }

    const now = Date.now();
    for (const prNumber of prNumbers) {
      let obs = observations.get(prNumber);
      if (!obs || now - obs.observedAt > config.observationTtlMs) {
        const fresh = await verifyChecksForPr(prNumber, config.ghBinary);
        if (fresh) {
          observations.set(prNumber, fresh);
          obs = fresh;
        } else {
          if (config.verbose) {
            process.stderr.write(
              `[pr-gate] gh pr checks ${prNumber} failed or returned no rows; treating as unverified\n`,
            );
          }
        }
      }
      if (!obs) {
        return {
          allow: false,
          reason:
            `Green-claim phrase gated for PR #${prNumber}: no 'gh pr checks ${prNumber}' ` +
            `observation succeeded within the last ${Math.round(config.observationTtlMs / 1000)}s. ` +
            `Run 'gh pr checks ${prNumber}' first and confirm all required contexts are PASS, then retry.`,
          code: "GREEN_CLAIM_NO_CHECK_EVIDENCE",
        };
      }
      if (!obs.allChecksPassed) {
        return {
          allow: false,
          reason:
            `Green-claim phrase gated for PR #${prNumber}: at least one required check is not PASS. ` +
            `Run 'gh pr checks ${prNumber}' and confirm all required contexts are PASS before retrying.`,
          code: "GREEN_CLAIM_CHECK_NOT_PASS",
        };
      }
    }
    return { allow: true };
  };
}

export default function registerPrGate(rawConfig: GateConfig = {}) {
  const config: Required<GateConfig> = {
    greenClaimPhrases: rawConfig.greenClaimPhrases ?? DEFAULT_GREEN_CLAIM_PHRASES,
    prReferencePattern: rawConfig.prReferencePattern ?? DEFAULT_PR_REFERENCE_PATTERN,
    ghBinary: rawConfig.ghBinary ?? "gh",
    observationTtlMs: rawConfig.observationTtlMs ?? 5 * 60 * 1000,
    verbose: rawConfig.verbose ?? false,
  };
  registerMessageSendingGate(gateHandler(config));
  return {
    manifest,
    config,
  };
}

export { verifyChecksForPr, findPrReferences, containsGreenClaim };
