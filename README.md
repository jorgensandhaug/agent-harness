# Agent Harness

## Config

- `harness.example.json` and `webhook-receiver.example.json` provide safe starter configs.
- Keep runtime overrides local (`harness.json`, `webhook-receiver.json`, `*.local.json`) since they are gitignored.

## Inspector

Run:

```bash
bun run inspect
```

Open:

```text
http://localhost:7070/inspect
```

`/inspect` lets you create projects/agents, stream events, poll output, and copy the tmux attach command with one click.

## Smoke

Run:

```bash
bun run smoke
```

Smoke auto-copies attach command at agent start and supports `c` to copy again while running.

## Subscription Discovery

Discovery is config-driven via `subscriptionDiscovery.sources` and `subscriptionDiscovery.profiles`.

```json
{
  "subscriptionDiscovery": {
    "enabled": true,
    "includeDefaults": true,
    "sources": {
      "claude_env": { "kind": "env", "name": "CLOUDGENI_CLAUDE_TOKEN" },
      "openai_op": {
        "kind": "command",
        "command": "op",
        "args": ["read", "op://vault/item/openai_api_key"]
      }
    },
    "profiles": [
      {
        "provider": "claude-code",
        "source": "claude_env",
        "valueType": "token",
        "label": "cloudgeni"
      },
      {
        "provider": "codex",
        "source": "openai_op",
        "valueType": "apiKey",
        "label": "op"
      }
    ]
  }
}
```

Legacy fields (`claudeDirs`, `claudeTokenFiles`, `codexDirs`) still work.

## Messages API (Internals-First)

Structured provider-internals messages (not tmux pane text):

```text
GET /api/v1/projects/:name/agents/:id/messages?limit=50&role=all
```

Latest assistant message:

```text
GET /api/v1/projects/:name/agents/:id/messages/last
```
