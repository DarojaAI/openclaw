/**
 * Session recall hook handler
 *
 * Automatically searches memory at session startup and injects results as hidden
 * system context before the first user turn.
 *
 * ARCHITECTURAL BLOCKER:
 * This hook cannot directly call memory_search because:
 * 1. agent:bootstrap fires BEFORE the agent session is fully initialized
 * 2. memory_search is a tool that requires an active agent runtime
 * 3. Bootstrap hooks can only modify bootstrapFiles, not invoke tools
 *
 * PROPOSED SOLUTION:
 * - Move to a session extension (not a bundled hook) that listens to session_start
 * - OR: Create a new lifecycle event "session:first-turn-prepare" that fires after
 *   agent initialization but before the first user turn is processed
 * - OR: Add a memory-search-sdk function that can be called outside tool context
 */

import path from "node:path";
import {
  resolveDefaultAgentId,
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import type { WorkspaceBootstrapFile } from "../../../agents/workspace.js";
import {
  resolveAgentIdFromSessionKey,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";

const log = createSubsystemLogger("hooks/session-recall");

/**
 * Configuration options for session-recall hook
 */
interface SessionRecallConfig {
  /** Maximum number of memory search results to include (default: 5) */
  maxResults?: number;
  /** Minimum relevance score for memory results 0.0-1.0 (default: 0.3) */
  minScore?: number;
  /** Maximum tokens for the injected context block (default: 800) */
  maxTokens?: number;
  /** Custom query for memory search (default: auto-derived from session) */
  query?: string;
}

/**
 * Estimates token count using a simple heuristic (1 token ≈ 4 characters)
 * This is a rough approximation; real tokenization varies by model.
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Derives a search query from session context
 * Since we don't have access to recent messages at bootstrap time, we use
 * a generic query that will match recent memory entries.
 */
function deriveSearchQuery(context: Record<string, unknown>): string {
  // At bootstrap time, we don't have message history yet
  // Use a generic query that pulls recent context
  return "recent conversation context, decisions, and important information";
}

/**
 * Formats memory search results as a hidden bootstrap context block
 */
function formatRecallContext(results: MemorySearchResult[], maxTokens: number): string {
  let context = `<!-- openclaw:recall-context -->\n`;
  context += `# Recall Context (Hidden)\n\n`;
  context += `Relevant context from prior conversations:\n\n`;

  let currentTokens = estimateTokenCount(context);

  for (const result of results) {
    const entry = `## ${result.path}\n\nScore: ${result.score.toFixed(2)}\n\n${result.content}\n\n`;
    const entryTokens = estimateTokenCount(entry);

    if (currentTokens + entryTokens > maxTokens) {
      context += `\n_[Additional results omitted due to token budget]_\n\n`;
      break;
    }

    context += entry;
    currentTokens += entryTokens;
  }

  context += `<!-- /openclaw:recall-context -->`;
  return context;
}

/**
 * Placeholder type for memory search results
 * In a real implementation, this would come from the memory plugin
 */
interface MemorySearchResult {
  path: string;
  content: string;
  score: number;
}

/**
 * STUB: Search memory for relevant context
 *
 * This is where we would call memory_search, but that's not possible from
 * a bootstrap hook. This stub demonstrates the intended API contract.
 *
 * @returns Mock results for demonstration purposes
 */
async function searchMemory(params: {
  query: string;
  workspaceDir: string;
  maxResults: number;
  minScore: number;
  cfg?: OpenClawConfig;
}): Promise<MemorySearchResult[]> {
  // BLOCKER: Cannot call memory_search here because:
  // 1. Memory tools require an active agent session
  // 2. Bootstrap hooks fire before agent initialization
  // 3. No SDK function exists for memory search outside tool context

  log.warn(
    "Memory search from bootstrap hook is not yet implemented. " +
      "This requires either a new lifecycle event or conversion to a session extension.",
  );

  // Return empty results so the session can continue normally
  return [];
}

/**
 * Session recall hook handler
 *
 * Fires on agent:bootstrap to inject memory search results as hidden context.
 *
 * NOTE: This implementation demonstrates the intended behavior but cannot
 * actually perform memory search due to architectural constraints documented above.
 */
const sessionRecallHook: HookHandler = async (event) => {
  // Only handle agent:bootstrap events
  if (event.type !== "agent" || event.action !== "bootstrap") {
    return undefined;
  }

  try {
    log.debug("Session recall hook triggered", {
      sessionKey: event.sessionKey,
      type: event.type,
      action: event.action,
    });

    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const workspaceDir =
      typeof context.workspaceDir === "string" && context.workspaceDir.trim()
        ? context.workspaceDir
        : undefined;
    const bootstrapFiles = (context.bootstrapFiles as WorkspaceBootstrapFile[]) || [];

    if (!workspaceDir) {
      log.debug("No workspace directory in context, skipping recall");
      return undefined;
    }

    // Read hook configuration
    const hookConfig = resolveHookConfig(cfg, "session-recall") as SessionRecallConfig | undefined;
    const maxResults = hookConfig?.maxResults ?? 5;
    const minScore = hookConfig?.minScore ?? 0.3;
    const maxTokens = hookConfig?.maxTokens ?? 800;
    const customQuery = hookConfig?.query;

    // Derive search query
    const query = customQuery ?? deriveSearchQuery(context);
    log.debug("Searching memory", { query, maxResults, minScore });

    // Search memory for relevant context
    const results = await searchMemory({
      query,
      workspaceDir,
      maxResults,
      minScore,
      cfg,
    });

    if (results.length === 0) {
      log.debug("No memory results found, skipping injection");
      return undefined;
    }

    log.debug("Found memory results", { count: results.length });

    // Format results as hidden context
    const recallContent = formatRecallContext(results, maxTokens);

    // Create a virtual bootstrap file that will be injected as hidden context
    const recallFile: WorkspaceBootstrapFile = {
      path: "<recall>",
      content: recallContent,
      label: "Recall Context",
      // Mark as hidden so it's visible to the model but not in the transcript
      hidden: true,
    };

    // Inject at the beginning so recall context appears before other bootstrap files
    bootstrapFiles.unshift(recallFile);

    // Update the context with modified bootstrap files
    (event.context as Record<string, unknown>).bootstrapFiles = bootstrapFiles;

    log.info("Injected recall context", {
      resultsCount: results.length,
      estimatedTokens: estimateTokenCount(recallContent),
    });

    return undefined;
  } catch (err) {
    // Never block session startup on recall failures
    const message = err instanceof Error ? err.message : String(err);
    log.error("Session recall hook failed", { error: message });
    return undefined;
  }
};

export default sessionRecallHook;
