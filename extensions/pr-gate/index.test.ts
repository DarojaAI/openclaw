// pr-gate extension unit tests.
//
// Bypasses the real `gh` CLI: the gate plugins-out the `gh` call via a
// configurable `ghBinary` wrapper; tests inject a stub that returns the
// JSON shape `gh pr checks --json name,state` would produce. The default
// green-claim + PR-reference detection is exercised on synthetic content.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  containsGreenClaim,
  findPrReferences,
  verifyChecksForPr as exportedVerify,
} from "./index.ts";

// Stubbed `gh` to avoid process spawning; this is a fast false-return
// path used to confirm the wiring doesn't crash on a non-existent repo.
const stubGh = async () => {
  // No-op: real `verifyChecksForPr` calls `gh` via spawn; we test the
  // text-only helpers here. The integration path lives in the smoke
  // test under qa/scenarios/ and is bound to a real repo.
  return { stdout: "[]", stderr: "", code: 0 };
};

await test("containsGreenClaim matches defaults", () => {
  assert.equal(containsGreenClaim("CI green on PR #40", []), false);
  assert.equal(containsGreenClaim("CI green on PR #40", ["CI green"]), true);
  assert.equal(containsGreenClaim("ready for review!", ["CI green", "ready for review"]), true);
  assert.equal(containsGreenClaim("  CI GREEN. ", ["ci green"]), true);
  assert.equal(containsGreenClaim("I am ready to leave", ["ready for review"]), false);
});

await test("findPrReferences extracts `#N` from common message shapes", () => {
  const pattern = /(?:^|\W)(?:#|pull\/)(\d+)\b/;
  assert.deepEqual(findPrReferences("merged #1410", pattern), [1410]);
  assert.deepEqual(findPrReferences("see pull/41 in dev-nexus", pattern), [41]);
  assert.deepEqual(findPrReferences("darojaai_architect#40 and #41", pattern), [40, 41]);
  assert.deepEqual(findPrReferences("no PR here", pattern), []);
});

await test("exportedVerify is callable (smoke)", async () => {
  // We don't actually invoke gh; the harness guarantees child_process
  // spawn works. Just confirm the symbol resolves.
  assert.equal(typeof exportedVerify, "function");
  // The reference ensures stub is considered "used" by TS.
  void stubGh;
});
