// Age-driven retention regressions (Clawsweeper findings on PR #176883).
// Kept as a sibling module of session-history-eviction.test.ts so the
// enforcement suite stays under the line-cap ratchet.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import { appendTranscriptMessage, resetSessionEntryLifecycle } from "./session-accessor.js";
import { installHistoryBudgetState } from "./session-history-budget-state.test-support.js";
import { createSessionHistoryBudgetFixture } from "./session-history-budget.test-support.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
} from "./session-history-eviction.js";

describe("SQLite historical session disk budget age retention", () => {
  let tempDir: string;
  let storePath: string;
  const {
    createHistoricalTranscript,
    database,
    settlePhysicalUsage,
    setSessionUpdatedAt,
    sessionExists,
    readArchiveNames,
  } = createSessionHistoryBudgetFixture(() => ({ storePath, tempDir }));

  installHistoryBudgetState("openclaw-session-history-budget-age-", (_state, dir, store) => {
    tempDir = dir;
    storePath = store;
  });

  it("gates below-budget previews on pressure instead of retained archives", async () => {
    // A retained archive file below the maximum budget must not make the
    // preview predict mutation: below-budget passes only extract age-qualified
    // generations, and this generation is younger than the cutoff.
    await createHistoricalTranscript({
      content: "recent preview history",
      nextSessionId: "live-history",
      sessionId: "recent-history",
      sessionKey: "agent:main:preview-pressure",
      updatedAt: 85_000,
    });
    setSessionUpdatedAt("live-history", 90_000);
    fs.writeFileSync(
      path.join(tempDir, "preview-retained.jsonl.deleted.2026-01-01T00-00-00.000Z"),
      Buffer.alloc(8),
    );
    settlePhysicalUsage();
    const usage = await measureSessionPhysicalDiskUsage(storePath);

    const inspected = await inspectSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      now: 100_000,
      maintenance: {
        maxDiskBytes: usage.totalBytes + 1024,
        highWaterBytes: usage.totalBytes - 1024,
        archiveAfterMs: 60_000,
      },
    });

    expect(inspected.diskBudget?.overBudget).toBe(false);
    expect(inspected.wouldMutate).toBe(false);
  });

  it("keeps below-budget pressure tiers off when archiveAfter is set", async () => {
    // Usage sits between highWaterBytes and maxDiskBytes: an age-enabled pass
    // below the maximum budget must only extract age-qualified generations and
    // must not let the pressure tiers prune archives or evict younger history.
    const sessionKey = "agent:main:below-budget-age";
    await createHistoricalTranscript({
      content: "old " + "x".repeat(4 * 1024),
      nextSessionId: "young-history",
      sessionId: "old-history",
      sessionKey,
      updatedAt: 1_000,
    });
    await appendTranscriptMessage(
      { sessionId: "young-history", sessionKey, storePath },
      { message: { role: "user", content: "young " + "y".repeat(4 * 1024) } },
    );
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => ({ sessionId: "live-history", updatedAt: 90_000 }),
    });
    setSessionUpdatedAt("young-history", 85_000);
    settlePhysicalUsage();
    const usage = await measureSessionPhysicalDiskUsage(storePath);

    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      now: 100_000,
      maintenance: {
        // cutoff = 40_000: only old-history (updatedAt 1_000) predates it.
        archiveAfterMs: 60_000,
        maxDiskBytes: usage.totalBytes + 1024,
        highWaterBytes: usage.totalBytes - 24 * 1024,
      },
    });

    expect(result?.overBudget).toBe(false);
    // Only the age-qualified generation is extracted; the younger generation
    // survives despite usage being above high water, and no retained archive is
    // pruned by below-budget pressure.
    expect(result?.removedEntries).toBe(1);
    expect(result?.removedFiles).toBe(0);
    expect(sessionExists("old-history")).toBe(false);
    expect(sessionExists("young-history")).toBe(true);
    expect(sessionExists("live-history")).toBe(true);
    expect(readArchiveNames("old-history")).toHaveLength(1);
    expect(readArchiveNames("young-history")).toHaveLength(0);
  });

  it("ages eligible history below high water with the default budget enabled", async () => {
    // archiveAfter alone (default 10 GiB budget, 8 GiB high water) must not
    // make the age expiry a no-op: an eligible generation below high water is
    // still extracted, and its freed pages are reclaimed through the
    // maintenance reclamation lifecycle.
    const sessionKey = "agent:main:age-default-budget";
    await createHistoricalTranscript({
      content: "old " + "x".repeat(64 * 1024),
      nextSessionId: "live-history",
      sessionId: "old-history",
      sessionKey,
      updatedAt: 1_000,
    });
    setSessionUpdatedAt("live-history", 90_000);
    settlePhysicalUsage();
    const usage = await measureSessionPhysicalDiskUsage(storePath);

    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      now: 100_000,
      maintenance: {
        maxDiskBytes: usage.totalBytes * 2,
        highWaterBytes: usage.totalBytes * 2,
        archiveAfterMs: 60_000,
      },
    });

    expect(result?.overBudget).toBe(false);
    expect(result?.removedEntries).toBe(1);
    expect(result?.freedBytes).toBeGreaterThan(0);
    expect(sessionExists("old-history")).toBe(false);
    expect(sessionExists("live-history")).toBe(true);
    expect(readArchiveNames("old-history")).toHaveLength(1);
  });

  it("retries pending page reclamation below high water without requiring another deletion", async () => {
    const sessionKey = "agent:main:reclaim-retry";
    await createHistoricalTranscript({
      content: "recent " + "x".repeat(32 * 1024),
      nextSessionId: "live-history",
      sessionId: "recent-history",
      sessionKey,
      updatedAt: 85_000,
    });
    setSessionUpdatedAt("live-history", 95_000);
    settlePhysicalUsage();
    const owner = database();
    owner.walMaintenance.checkpoint();
    // Simulate a previous pass's postponed reclamation: free pages sit in the
    // freelist with no new deletion in this pass to trigger reclamation.
    owner.db.exec("CREATE TABLE _reclaim_retry_fixture (id INTEGER PRIMARY KEY, body TEXT);");
    owner.db.exec(
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000) " +
        "INSERT INTO _reclaim_retry_fixture SELECT x, hex(randomblob(512)) FROM n;",
    );
    owner.walMaintenance.checkpoint();
    owner.db.exec("DROP TABLE _reclaim_retry_fixture;");
    owner.walMaintenance.checkpoint();
    const freelistBefore = Number(
      owner.db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0,
    );
    expect(freelistBefore).toBeGreaterThan(0);
    const sizeBefore = fs.statSync(owner.path).size;

    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      now: 100_000,
      maintenance: { maxDiskBytes: null, highWaterBytes: null, archiveAfterMs: 60_000 },
    });

    // recent-history (updatedAt 85_000) is not age-eligible (cutoff 40_000):
    // no rows are deleted, yet the pass still retries the pending reclamation.
    expect(result?.removedEntries).toBe(0);
    const freelistAfter = Number(
      owner.db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0,
    );
    expect(freelistAfter).toBe(0);
    expect(fs.statSync(owner.path).size).toBeLessThan(sizeBefore);
  });

  it("defers reclamation of legacy auto_vacuum=NONE stores to Doctor instead of an online VACUUM", async () => {
    const sessionKey = "agent:main:age-vacuum";
    await createHistoricalTranscript({
      content: "old vacuum " + "z".repeat(64 * 1024),
      nextSessionId: "live-history",
      sessionId: "old-history",
      sessionKey,
      updatedAt: 1_000,
    });
    setSessionUpdatedAt("live-history", 90_000);
    settlePhysicalUsage();

    const owner = database();
    const dbPath = owner.path;
    // Simulate the legacy pre-flip databases that never received doctor's
    // auto_vacuum=INCREMENTAL retrofit: mode NONE keeps deleted pages forever.
    owner.walMaintenance.checkpoint();
    owner.db.exec("PRAGMA auto_vacuum = NONE;");
    owner.db.exec("VACUUM;");
    const beforePages = Number(
      (owner.db.prepare("PRAGMA page_count").get() as { page_count?: unknown } | undefined)
        ?.page_count ?? 0,
    );

    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      now: 100_000,
      maintenance: { maxDiskBytes: null, highWaterBytes: null, archiveAfterMs: 60_000 },
    });

    expect(result?.removedEntries).toBe(1);
    expect(sessionExists("old-history")).toBe(false);
    const vacuumRow = owner.db.prepare("PRAGMA auto_vacuum").get() as
      | { auto_vacuum?: unknown }
      | undefined;
    // The maintenance pass must NOT flip the header or run the full synchronous
    // VACUUM on the foreground writer path; the header stays NONE and the page
    // count is untouched (a full VACUUM would repack and shrink it), so
    // Doctor's offline sqlite reclamation owns the conversion.
    expect(Number(vacuumRow?.auto_vacuum ?? 0)).toBe(0);
    const afterPages = Number(
      (owner.db.prepare("PRAGMA page_count").get() as { page_count?: unknown } | undefined)
        ?.page_count ?? 0,
    );
    expect(afterPages).toBe(beforePages);
    expect(beforePages).toBeGreaterThan(0);
    expect(result?.deferredReason).toBe("doctor-retrofit-required");
  });
});
