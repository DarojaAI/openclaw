# @openclaw/daroja-pr-gate

DarojaAI PR-closeout enforcement. Implements RFC
[DarojaAI/.github#33](https://github.com/DarojaAI/.github/issues/33).

## What it does

Registers a `message:sending` pre-send gate. When an agent tries to
send an outbound message containing a "green-claim" phrase (e.g.
"CI green", "ready for review", "expected green") and a PR number is
referenced in the message body, the gate issues `gh pr checks <n>`
and:

| State                                             | Outcome                                        |
| ------------------------------------------------- | ---------------------------------------------- |
| All required contexts `PASS`/`SKIPPED`/`NEUTRAL`  | Allow the send                                 |
| Observation missing (spawn failed, gh not authed) | **Block** with `GREEN_CLAIM_NO_CHECK_EVIDENCE` |
| At least one context not `PASS`                   | **Block** with `GREEN_CLAIM_CHECK_NOT_PASS`    |
| Message has green-claim phrase but no PR number   | **Block** with `GREEN_CLAIM_NO_PR_REFERENCE`   |

A successful `gh pr checks <n>` observation is cached in process memory
for `observationTtlMs` (default 5 minutes). After the TTL expires
without a fresh call, the gate requires re-verification.

## Configuration

| Key                  | Default                                                                         | Notes                                                                       |
| -------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `greenClaimPhrases`  | `["CI green", "ready for review", "ready for your approval", "expected green"]` | Mirror of the AGENTS.md rule text added in `DarojaAI/darojaai_architect#41` |
| `prReferencePattern` | `/(?:^\|\W)(?:#\|pull\/)(\d+)\b/`                                               | Regex source for PR-number extraction.                                      |
| `ghBinary`           | `"gh"`                                                                          | Absolute path if not on PATH.                                               |
| `observationTtlMs`   | `300_000` (5 min)                                                               | Hard cap on stale cache.                                                    |
| `verbose`            | `false`                                                                         | Log every gate decision to stderr.                                          |

## Constraints (v1)

- **Process-local cache.** The observation cache lives in module scope;
  a process restart resets it. A future iteration should persist the
  cache to a WIF-provisioned per-session store so cross-process reads
  are honest.
- **`gh` CLI required on PATH.** The plugin invokes the GitHub CLI as
  a child process. CI environments without `gh` will see every gate
  decision return `GREEN_CLAIM_NO_CHECK_EVIDENCE` until the binary is
  available.
- **Default-allow when no handlers registered.** This plugin is
  opt-in. Operators who want enforcement must register the gate handler
  at OpenClaw startup (see [the OpenClaw plugin docs](./building-extensions.md)).

## Plan reference

PR `DarojaAI/openclaw#1` lands the gate API; PR `DarojaAI/openclaw#2`
wires it into the outbound send site; this extension is the consumer.
RFC `DarojaAI/.github#33` is the org-wide rule text and tool-hook
specification that this extension enforces.
