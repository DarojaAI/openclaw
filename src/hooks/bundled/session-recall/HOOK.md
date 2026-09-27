---
name: session-recall
description: "Automatically search memory and inject relevant context at session startup"
homepage: https://docs.openclaw.ai/automation/hooks#session-recall
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Recall Hook

Automatically searches memory at session startup and injects relevant context as hidden system context before the first user turn.

## What It Does

When a new agent session starts (or a session is reset):

1. **Searches memory** - Runs `memory_search` with a startup query derived from recent session context
2. **Injects as hidden context** - Adds search results as a hidden system context block visible to the model but not shown in the transcript
3. **Respects token budget** - Limits injected content to a maximum token count to avoid overwhelming the context window

## Why This Matters

Without automatic recall, agents must explicitly call `memory_search` in every session to retrieve relevant context from prior conversations. This creates a failure class where:

- Agents forget to search memory and miss critical context
- Users must remind the agent to check memory
- First responses lack context that should be immediately available

Automatic recall prevents this by ensuring memory search happens before the agent ever sees the first user message.

## Output Format

The hook injects a hidden context block at the top of the system prompt:

```markdown
<!-- openclaw:recall-context -->
# Recall Context (Hidden)

Relevant context from prior conversations:

[Search results from memory_search]

<!-- /openclaw:recall-context -->
```

This block is visible to the model but **not** included in the user-facing transcript.

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during setup)
- **Memory**: Memory search must be enabled (`memory.search.enabled: true`)

## Configuration

The hook supports optional configuration:

| Option          | Type   | Default | Description                                                          |
| --------------- | ------ | ------- | -------------------------------------------------------------------- |
| `maxResults`    | number | 5       | Maximum number of memory search results to include                   |
| `minScore`      | number | 0.3     | Minimum relevance score for memory results (0.0-1.0)                 |
| `maxTokens`     | number | 800     | Maximum tokens for the injected context block                        |
| `query`         | string | auto    | Custom query for memory search (default: derived from session state) |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-recall": {
          "enabled": true,
          "maxResults": 10,
          "minScore": 0.4,
          "maxTokens": 1200
        }
      }
    }
  }
}
```

The hook automatically:

- Uses your workspace directory (`~/.openclaw/workspace` by default)
- Derives a search query from the session context (user messages, active tools, etc.)
- Runs memory search in the background during bootstrap
- Injects results as hidden context before the first agent turn
- Respects the configured token budget to avoid context overflow

## Disabling

To disable this hook:

```bash
openclaw hooks disable session-recall
```

Or remove it from your config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-recall": { "enabled": false }
      }
    }
  }
}
```

## Technical Details

### Lifecycle Placement

The hook fires on `agent:bootstrap`, which occurs:
- **Before** workspace files (AGENTS.md, MEMORY.md, etc.) are injected
- **Before** the first user turn is processed
- **After** the agent session is created and workspace is resolved

This ensures recall context is available from the very first model interaction.

### Hidden vs Visible

The injected context is marked as a "bootstrap file" with a special flag that:
- Makes it visible to the model in the system prompt
- Excludes it from the user-facing transcript
- Prevents it from being persisted in session storage

### Token Budget Policy

The hook enforces a hard token limit (default: 800 tokens) by:
1. Counting tokens in each memory search result
2. Including results in order of relevance until the budget is exhausted
3. Truncating or omitting results that would exceed the limit

This prevents recall from consuming excessive context window capacity.

## Failure Modes

The hook handles failures gracefully:

- **Memory search unavailable**: Skips injection, logs warning, continues normally
- **No results found**: Skips injection (empty context), continues normally  
- **Query derivation fails**: Falls back to a generic search query
- **Token counting fails**: Falls back to character-based estimation

In all cases, session startup continues — recall failures never block agent initialization.
