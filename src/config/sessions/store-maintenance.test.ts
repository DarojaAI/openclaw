import { describe, expect, it } from "vitest";
import {
  normalizeResolvedMaintenanceConfigInput,
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfigInput,
} from "./store-maintenance.js";

describe("session maintenance archiveAfter resolution", () => {
  it("defaults to null (pressure-only archival) when unset", () => {
    expect(resolveMaintenanceConfigFromInput(undefined).archiveAfterMs).toBeNull();
    expect(resolveMaintenanceConfigFromInput({}).archiveAfterMs).toBeNull();
  });

  it("resolves a positive duration to milliseconds", () => {
    const resolved = resolveMaintenanceConfigFromInput({ archiveAfter: "90d" });
    expect(resolved.archiveAfterMs).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("accepts explicit false as a disable", () => {
    expect(resolveMaintenanceConfigFromInput({ archiveAfter: false }).archiveAfterMs).toBeNull();
  });

  it("keeps the disable side for malformed durations so history is never aged out by a typo", () => {
    expect(resolveMaintenanceConfigFromInput({ archiveAfter: "never" }).archiveAfterMs).toBeNull();
  });

  it("normalizes resolved input through the maintenance input shape", () => {
    const full = resolveMaintenanceConfigFromInput({ archiveAfter: "30d", pruneAfter: "14d" });
    expect(full.archiveAfterMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(full.pruneAfterMs).toBe(14 * 24 * 60 * 60 * 1000);
    expect(normalizeResolvedMaintenanceConfigInput(full).archiveAfterMs).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
  });

  it("accepts an omitted archiveAfterMs at the input boundary and normalizes it to null", () => {
    // Public SDK patchSessionEntry callers opt out of age-driven archival by
    // omitting the key; the input boundary must not force it on them, and the
    // normalized resolved config must treat the omission as disabled.
    const input: ResolvedSessionMaintenanceConfigInput = {
      mode: "enforce",
      pruneAfterMs: 30 * 24 * 60 * 60 * 1000,
      maxEntries: 5000,
      resetArchiveRetentionMs: null,
      maxDiskBytes: 10 * 1024 * 1024 * 1024,
      highWaterBytes: 8 * 1024 * 1024 * 1024,
    };
    expect(input.archiveAfterMs).toBeUndefined();
    expect(normalizeResolvedMaintenanceConfigInput(input).archiveAfterMs).toBeNull();
  });
});
