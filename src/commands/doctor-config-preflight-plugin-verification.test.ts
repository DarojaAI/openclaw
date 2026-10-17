import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePluginNpmProjectsDir } from "../plugins/install-paths.js";
import { listManagedPluginNpmRootsForInstallRecords } from "../plugins/npm-project-roots.js";
import { formatStartupPluginVerificationFailure } from "./doctor-config-preflight-plugin-verification.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("formatStartupPluginVerificationFailure", () => {
  it("uses install-neutral gateway restart guidance", () => {
    expect(
      formatStartupPluginVerificationFailure({
        kind: "plugin-verification",
        messages: ['Plugin "discord" has no install path.'],
      }),
    ).toBe(
      [
        "OpenClaw plugin verification failed; refusing to report the gateway ready.",
        '- Plugin "discord" has no install path.',
        "Resolve the plugin verification errors above, then restart the Gateway.",
      ].join("\n"),
    );
  });
});

describe("plugin verification scan scoping (#143)", () => {
  it("scopes the verification walk to the plugins' own package directories, excluding stale generation trees", () => {
    const npmRoot = tempDirs.make("openclaw-plugin-verification-scope-");
    const projectsDir = resolvePluginNpmProjectsDir(npmRoot);
    const activeGeneration = path.join(projectsDir, "codex__openclaw-generation__g-active");
    const staleGeneration = path.join(projectsDir, "codex__openclaw-generation__g-stale");
    fs.mkdirSync(activeGeneration, { recursive: true });
    fs.mkdirSync(staleGeneration, { recursive: true });

    const roots = listManagedPluginNpmRootsForInstallRecords({
      npmBaseDir: npmRoot,
      installRecords: {
        codex: {
          source: "npm",
          installPath: path.join(activeGeneration, "node_modules", "@openclaw", "codex"),
        },
      },
      env: {},
    });

    // The base npm root plus the active generation are scanned; the stale
    // accumulated generation tree is not, so repeated scans are O(changes)
    // rather than O(all bytes under the captures root).
    expect(roots).toEqual([npmRoot, activeGeneration]);
    expect(roots).not.toContain(staleGeneration);
  });

  it("keeps a direct base-root install in scope", () => {
    const npmRoot = tempDirs.make("openclaw-plugin-verification-scope-base-");
    fs.mkdirSync(path.join(npmRoot, "node_modules"), { recursive: true });

    const roots = listManagedPluginNpmRootsForInstallRecords({
      npmBaseDir: npmRoot,
      installRecords: {
        discord: {
          source: "npm",
          installPath: path.join(npmRoot, "node_modules", "@openclaw", "discord"),
        },
      },
      env: {},
    });

    expect(roots).toEqual([npmRoot]);
  });
});
