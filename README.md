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

## Messages API (Internals-First)

Structured provider-internals messages (not tmux pane text):

```text
GET /api/v1/projects/:name/agents/:id/messages?limit=50&role=all
```

Latest assistant message:

```text
GET /api/v1/projects/:name/agents/:id/messages/last
```
