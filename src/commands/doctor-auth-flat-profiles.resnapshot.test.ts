// Doctor flat auth re-snapshot idempotency tests: a reappeared legacy auth
// source already owned by a terminal migration receipt must not mint a fresh
// .migrated-* archive on every run. Sibling to doctor-auth-flat-profiles.test.ts
// so the oversized repair test module does not grow past the line-cap ratchet.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";
import { makePrompter } from "./doctor-auth-flat-profiles.test-support.js";

const states: OpenClawTestState[] = [];

async function makeTestState(): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-flat-auth-resnapshot-",
    env: {
      OPENCLAW_AGENT_DIR: undefined,
    },
  });
  states.push(state);
  return state;
}

function migrateAuthProfiles(
  params: Partial<Parameters<typeof maybeMigrateAuthProfileJsonStoresToSqlite>[0]> = {},
) {
  return maybeMigrateAuthProfileJsonStoresToSqlite({
    cfg: {},
    prompter: makePrompter(true),
    ...params,
  });
}

async function writeLegacyAuthProfilesJson(
  state: OpenClawTestState,
  value: unknown,
): Promise<string> {
  return await state.writeText(
    "agents/main/agent/auth-profiles.json",
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function listMigratedArchives(sourcePath: string): string[] {
  const prefix = `${path.basename(sourcePath)}.migrated-`;
  return fs
    .readdirSync(path.dirname(sourcePath))
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(path.dirname(sourcePath), entry));
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("doctor flat auth re-snapshot idempotency", () => {
  it("does not re-snapshot a reappeared already-migrated auth-profiles.json", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "not-a-real" },
      },
    });
    const sourceBytes = fs.readFileSync(authPath);

    await migrateAuthProfiles({ env: state.env });
    fs.writeFileSync(authPath, sourceBytes);

    const replay = await migrateAuthProfiles({ env: state.env });

    expect(replay.changes).toEqual([expect.stringContaining("without a new snapshot")]);
    expect(
      loadPersistedAuthProfileStore(state.agentDir())?.profiles["openai:default"],
    ).toMatchObject({ type: "api_key", provider: "openai" });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(listMigratedArchives(authPath)).toHaveLength(1);
  });

  it("snapshots an already-migrated auth source again when its bytes changed", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "first-key" },
      },
    });
    await migrateAuthProfiles({ env: state.env });
    const mutated = `${JSON.stringify(
      {
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "first-key" },
          "anthropic:default": { type: "api_key", provider: "anthropic", key: "claude-key" },
        },
      },
      null,
      2,
    )}\n`;
    fs.writeFileSync(authPath, mutated, "utf8");

    const replay = await migrateAuthProfiles({ env: state.env });

    // Changed bytes have no terminal receipt, so Doctor snapshots them again
    // and imports the newly added profile without clobbering existing ones.
    expect(replay.changes).toEqual([expect.stringContaining("Migrated auth profile JSON for")]);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toMatchObject({
      "openai:default": { key: "first-key" },
      "anthropic:default": { key: "claude-key" },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    const archives = listMigratedArchives(authPath);
    expect(archives).toHaveLength(2);
    expect(
      archives.some((archive) => fs.readFileSync(archive).equals(Buffer.from(mutated, "utf8"))),
    ).toBe(true);
  });

  it("re-archives an already-migrated auth source when its terminal archive is missing", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "not-a-real" },
      },
    });
    const sourceBytes = fs.readFileSync(authPath);

    await migrateAuthProfiles({ env: state.env });
    const [archive] = listMigratedArchives(authPath);
    fs.rmSync(archive!);
    fs.writeFileSync(authPath, sourceBytes);

    const replay = await migrateAuthProfiles({ env: state.env });

    expect(replay.changes).toEqual([
      expect.stringContaining("Archived a previously migrated legacy auth source"),
    ]);
    expect(fs.existsSync(authPath)).toBe(false);
    expect(listMigratedArchives(authPath)).toHaveLength(1);
    expect(fs.readFileSync(listMigratedArchives(authPath)[0]!)).toEqual(sourceBytes);
  });
});
