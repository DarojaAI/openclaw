// Resolves npm project roots for plugin package inspection.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { isNotFoundPathError, isPathInside } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import { resolvePluginNpmProjectsDir } from "./install-paths.js";

function isMissing(error: unknown): boolean {
  return isNotFoundPathError(error);
}

function sortPaths(paths: string[]): string[] {
  return paths.toSorted((left, right) => left.localeCompare(right));
}

/** Lists project-level npm roots managed below the plugin npm root. */
export function listManagedPluginNpmProjectRootsSync(npmRoot: string): string[] {
  const projectsDir = resolvePluginNpmProjectsDir(npmRoot);
  try {
    return sortPaths(
      fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectsDir, entry.name)),
    );
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

/** Async variant of project-level managed npm root discovery. */
async function listManagedPluginNpmProjectRoots(npmRoot: string): Promise<string[]> {
  const projectsDir = resolvePluginNpmProjectsDir(npmRoot);
  try {
    return sortPaths(
      (await fsp.readdir(projectsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectsDir, entry.name)),
    );
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

/** Returns the root npm install plus all managed project npm roots. */
export function listManagedPluginNpmRootsSync(npmRoot: string): string[] {
  return [npmRoot, ...listManagedPluginNpmProjectRootsSync(npmRoot)];
}

/** Async variant of managed npm root discovery. */
export async function listManagedPluginNpmRoots(npmRoot: string): Promise<string[]> {
  return [npmRoot, ...(await listManagedPluginNpmProjectRoots(npmRoot))];
}

/**
 * Resolves the managed npm roots that own the plugins' own package
 * directories (the install paths recorded in the install ledger).
 *
 * The full managed npm root set includes every accumulated artifact-generation
 * project tree (`{package}__openclaw-generation__g-<hash>`), each of which is a
 * separate built npm tree with its own `node_modules`. Walking every one of
 * those trees is O(all bytes under the npm root) — the deploy-blocking cost
 * reported in #143. Scoping to only the roots that contain a recorded install
 * path keeps verification O(active plugins) while still covering every plugin
 * the ledger says is installed.
 */
export function listManagedPluginNpmRootsForInstallRecords(params: {
  npmBaseDir: string;
  installRecords: Record<string, PluginInstallRecord>;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const allRoots = listManagedPluginNpmRootsSync(params.npmBaseDir);
  const installPaths = new Set(
    Object.values(params.installRecords)
      .map((record) => record.installPath?.trim())
      .filter((installPath): installPath is string => Boolean(installPath))
      .map((installPath) => path.resolve(resolveUserPath(installPath, params.env))),
  );
  if (installPaths.size === 0) {
    return allRoots;
  }
  return allRoots.filter((root) =>
    [...installPaths].some((installPath) => isPathInside(root, installPath)),
  );
}
