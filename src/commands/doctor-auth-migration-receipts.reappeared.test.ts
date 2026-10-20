// Reappeared legacy auth source cleanup tests: the terminal receipt must only
// remove a recreated source when the retained archive still byte-matches the
// recorded fingerprint, and must preserve the source through the archival path
// when the retained archive is corrupt or unreadable. Sibling module because
// doctor-auth-migration-receipts.test.ts is at the line-cap ratchet.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  archiveOrCleanupReappearedAuthProfileSource,
  finalizeAuthProfileMigrationSource,
  prepareAuthProfileSourceReceipt,
  type AuthProfileMigrationSourceReceipt,
} from "./doctor-auth-migration-receipts.js";

describe("reappeared auth profile source cleanup", () => {
  const states: OpenClawTestState[] = [];

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    for (const state of states.splice(0)) {
      await state.cleanup();
    }
  });

  async function makeArchivedUnparsedReceipt(): Promise<{
    state: OpenClawTestState;
    sourcePath: string;
    receipt: AuthProfileMigrationSourceReceipt;
  }> {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-auth-reappeared-",
    });
    states.push(state);
    const sourcePath = await state.writeText(
      "credentials/oauth.json",
      `${JSON.stringify({ openai: { access: "fake", refresh: "fake", expires: 42 } })}\n`,
    );
    const receipt = prepareAuthProfileSourceReceipt({
      pathname: sourcePath,
      targetDatabasePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      targetTable: "auth_profile_store",
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      env: state.env,
    });
    finalizeAuthProfileMigrationSource(receipt, "archived-unparsed");
    return { state, sourcePath, receipt };
  }

  function prepareReappearedReceipt(
    sourcePath: string,
    state: OpenClawTestState,
  ): AuthProfileMigrationSourceReceipt {
    return prepareAuthProfileSourceReceipt({
      pathname: sourcePath,
      targetDatabasePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      targetTable: "auth_profile_store",
      now: () => Date.parse("2026-07-25T13:00:00.000Z"),
      env: state.env,
    });
  }

  it("deduplicates a reappeared source when the retained archive still matches", async () => {
    const { state, sourcePath, receipt } = await makeArchivedUnparsedReceipt();
    const sourceBytes = fs.readFileSync(receipt.archivePath);
    fs.writeFileSync(sourcePath, sourceBytes);

    const change = archiveOrCleanupReappearedAuthProfileSource(
      prepareReappearedReceipt(sourcePath, state),
    );

    expect(change).toEqual(expect.stringContaining("without a new snapshot"));
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(receipt.archivePath)).toBe(true);
  });

  it("preserves a reappeared source through the archival path when the retained archive is truncated", async () => {
    const { state, sourcePath, receipt } = await makeArchivedUnparsedReceipt();
    const sourceBytes = fs.readFileSync(receipt.archivePath);
    fs.writeFileSync(sourcePath, sourceBytes);
    // The retained terminal archive is then truncated by an external writer or
    // partial restore, so its existence can no longer prove the bytes survive.
    fs.writeFileSync(receipt.archivePath, "truncated garbage", "utf8");

    const reappeared = prepareReappearedReceipt(sourcePath, state);
    const change = archiveOrCleanupReappearedAuthProfileSource(reappeared);

    // The source must NOT be deleted while the retained archive is corrupt:
    // it falls back to the normal archival path and the bytes survive.
    expect(change).toEqual(
      expect.stringContaining("Archived a previously migrated legacy auth source"),
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.readFileSync(reappeared.archivePath)).toEqual(sourceBytes);
    // The corrupt retained archive is left untouched for diagnostics.
    expect(fs.readFileSync(receipt.archivePath, "utf8")).toBe("truncated garbage");
  });
});
