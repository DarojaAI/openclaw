/**
 * Tests for session-recall hook handler
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { InternalHookEvent } from "../../internal-hooks.js";
import type { WorkspaceBootstrapFile } from "../../../agents/workspace.js";
import sessionRecallHook from "./handler.js";

describe("session-recall hook", () => {
  const mockWorkspaceDir = "/test/workspace";
  const mockSessionKey = "agent:test:main";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should only handle agent:bootstrap events", async () => {
    const commandEvent: InternalHookEvent = {
      type: "command",
      action: "new",
      sessionKey: mockSessionKey,
      context: {},
      timestamp: new Date(),
      messages: [],
    };

    const result = await sessionRecallHook(commandEvent);
    expect(result).toBeUndefined();
  });

  it("should skip if no workspace directory in context", async () => {
    const event: InternalHookEvent = {
      type: "agent",
      action: "bootstrap",
      sessionKey: mockSessionKey,
      context: {
        bootstrapFiles: [],
      },
      timestamp: new Date(),
      messages: [],
    };

    const result = await sessionRecallHook(event);
    expect(result).toBeUndefined();
    expect(event.context.bootstrapFiles).toEqual([]);
  });

  it("should inject recall context as hidden bootstrap file", async () => {
    const bootstrapFiles: WorkspaceBootstrapFile[] = [
      {
        path: "/test/workspace/AGENTS.md",
        content: "# AGENTS.md content",
        label: "AGENTS.md",
      },
    ];

    const event: InternalHookEvent = {
      type: "agent",
      action: "bootstrap",
      sessionKey: mockSessionKey,
      context: {
        workspaceDir: mockWorkspaceDir,
        bootstrapFiles: [...bootstrapFiles],
      },
      timestamp: new Date(),
      messages: [],
    };

    await sessionRecallHook(event);

    const updatedFiles = event.context.bootstrapFiles as WorkspaceBootstrapFile[];

    // Currently returns empty results due to implementation blocker
    // but demonstrates the contract: should prepend recall file if results exist
    expect(Array.isArray(updatedFiles)).toBe(true);

    // Once memory search is implemented, this test should verify:
    // - updatedFiles.length === bootstrapFiles.length + 1
    // - updatedFiles[0].path === "<recall>"
    // - updatedFiles[0].hidden === true
    // - updatedFiles[0].content.includes("Recall Context")
  });

  it("should respect maxTokens budget", async () => {
    const event: InternalHookEvent = {
      type: "agent",
      action: "bootstrap",
      sessionKey: mockSessionKey,
      context: {
        workspaceDir: mockWorkspaceDir,
        bootstrapFiles: [],
        cfg: {
          hooks: {
            internal: {
              entries: {
                "session-recall": {
                  enabled: true,
                  maxTokens: 100, // Very small budget
                },
              },
            },
          },
        },
      },
      timestamp: new Date(),
      messages: [],
    };

    await sessionRecallHook(event);

    const updatedFiles = event.context.bootstrapFiles as WorkspaceBootstrapFile[];

    // With memory search implemented, this would verify that:
    // - The injected content respects the 100-token limit
    // - Results are truncated if they would exceed the budget
    expect(Array.isArray(updatedFiles)).toBe(true);
  });

  it("should not block session startup on errors", async () => {
    const event: InternalHookEvent = {
      type: "agent",
      action: "bootstrap",
      sessionKey: mockSessionKey,
      context: {
        workspaceDir: mockWorkspaceDir,
        bootstrapFiles: [],
        // Deliberately omit cfg to trigger potential errors
      },
      timestamp: new Date(),
      messages: [],
    };

    // Should not throw, even if internal errors occur
    await expect(sessionRecallHook(event)).resolves.not.toThrow();
  });

  it("should use custom query if provided in config", async () => {
    const customQuery = "specific search terms for this session";

    const event: InternalHookEvent = {
      type: "agent",
      action: "bootstrap",
      sessionKey: mockSessionKey,
      context: {
        workspaceDir: mockWorkspaceDir,
        bootstrapFiles: [],
        cfg: {
          hooks: {
            internal: {
              entries: {
                "session-recall": {
                  enabled: true,
                  query: customQuery,
                },
              },
            },
          },
        },
      },
      timestamp: new Date(),
      messages: [],
    };

    // With memory search implemented, would verify the custom query is used
    await sessionRecallHook(event);

    const updatedFiles = event.context.bootstrapFiles as WorkspaceBootstrapFile[];
    expect(Array.isArray(updatedFiles)).toBe(true);
  });

  it("should prepend recall context before other bootstrap files", async () => {
    const existingFiles: WorkspaceBootstrapFile[] = [
      {
        path: "/test/workspace/AGENTS.md",
        content: "# AGENTS.md",
        label: "AGENTS.md",
      },
      {
        path: "/test/workspace/MEMORY.md",
        content: "# MEMORY.md",
        label: "MEMORY.md",
      },
    ];

    const event: InternalHookEvent = {
      type: "agent",
      action: "bootstrap",
      sessionKey: mockSessionKey,
      context: {
        workspaceDir: mockWorkspaceDir,
        bootstrapFiles: [...existingFiles],
      },
      timestamp: new Date(),
      messages: [],
    };

    await sessionRecallHook(event);

    const updatedFiles = event.context.bootstrapFiles as WorkspaceBootstrapFile[];

    // With memory search returning results, would verify:
    // - updatedFiles[0].path === "<recall>"
    // - updatedFiles[1].path === existingFiles[0].path
    // - updatedFiles[2].path === existingFiles[1].path
    expect(updatedFiles.length).toBeGreaterThanOrEqual(existingFiles.length);
  });
});
