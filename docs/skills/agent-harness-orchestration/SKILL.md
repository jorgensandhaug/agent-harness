# Agent Harness Orchestration Skill

Use this skill to orchestrate `agent-harness` over HTTP API for single-agent or parallel-agent execution with deterministic recovery.

## Required Inputs

- `HARNESS_BASE_URL` (example: `http://127.0.0.1:7070/api/v1`)
- `PROJECT_CWD`
- `PROVIDER` (`claude-code|codex|pi|opencode`)
- `TASK`

Optional:

- `HARNESS_BEARER_TOKEN`
- `PROJECT_NAME`
- `MODEL`
- `SUBSCRIPTION`
- `PARALLEL_COUNT`
- `WEBHOOK_MODE` (`enabled|disabled`)
- `COMPLETION_MODE` (`all|any`)
- `TIMEOUTS` (`spawnTimeoutMs`, `completionTimeoutMs`, `idleGraceMs`)

## API Map

Projects:

- `POST /projects`
- `GET /projects`
- `GET /projects/:name`
- `DELETE /projects/:name`

Agents:

- `POST /projects/:name/agents`
- `GET /projects/:name/agents`
- `GET /projects/:name/agents/:id`
- `POST /projects/:name/agents/:id/input`
- `GET /projects/:name/agents/:id/output?lines=N`
- `GET /projects/:name/agents/:id/messages?limit=&role=`
- `GET /projects/:name/agents/:id/messages/last`
- `POST /projects/:name/agents/:id/abort`
- `DELETE /projects/:name/agents/:id`

Events:

- `GET /projects/:name/events?since=evt-N`
- `GET /projects/:name/agents/:id/events?since=evt-N`

Health:

- `GET /health` (no bearer required)

## Auth

When `HARNESS_BEARER_TOKEN` is set, send:

`Authorization: Bearer <token>`

for every `/api/v1/*` request except health.

## Status Semantics

Terminal:

- `idle`
- `error`
- `exited`

Non-terminal:

- `starting`
- `processing`
- `waiting_input`

## Core Flow A: Single Agent

1. Create project (`POST /projects`) with deterministic name (`PROJECT_NAME` or derived prefix).
2. Create agent (`POST /projects/:name/agents`) with `provider`, `task`, optional `model`, optional `subscription`.
3. Subscribe to agent SSE (`GET /projects/:name/agents/:id/events`).
4. Wait for terminal status (`idle|error|exited`).
5. Fetch final summary (`GET /messages/last`).
6. Return structured result.
7. Cleanup policy:
- keep failed agents/projects unless caller requests force cleanup
- delete successful ephemeral runs when requested

## Core Flow B: Parallel Dispatch

1. Ensure one project exists.
2. Spawn `N=PARALLEL_COUNT` agents in parallel.
3. Open one project SSE stream (`GET /projects/:name/events`).
4. Track per-agent state:
- current status
- last event id
- completion ts
- error marker
5. On terminal transition, fetch `/messages/last` for that agent.
6. Stop when completion criteria met:
- `all`: all agents terminal
- `any`: first successful `idle` terminal
7. Timeout handling:
- `POST /abort`
- short grace
- `DELETE` if still non-terminal

## Webhook-First Completion

If webhook receiver is enabled, treat webhook as a hint for fast-path completion fetch.

Still keep SSE/polling fallback:

1. webhook arrives
2. fetch `/messages/last`
3. reconcile with `GET /projects/:name/agents/:id`

## Reconnect + Replay

On SSE drop:

1. reconnect with `?since=<lastEventId>`
2. replay missed events
3. if replay gap suspected, reconcile via `GET /projects/:name/agents/:id`

## Error Recovery Policy

- `400 INVALID_REQUEST`: fix payload; no blind retry
- `401 UNAUTHORIZED`: refresh token, retry once
- `404 PROJECT_NOT_FOUND|AGENT_NOT_FOUND`: reconcile cache, recreate if needed
- `409 PROJECT_EXISTS`: reuse project or deterministic suffix
- `500 TMUX_ERROR|INTERNAL_ERROR`: bounded retry (max 2)
- `503 TMUX_UNAVAILABLE`: fail fast, host remediation required

Runtime failures:

- missed webhook: use SSE/poll fallback
- agent stuck `starting`: timeout -> delete -> respawn once
- agent stuck `processing`: abort unless workflow expects more input
- missing internals summary: fallback to `/messages?role=assistant&limit=N`, then `/output`

## Retry Guardrails

- max project-create retries: 2
- max agent-create retries: 2 per agent
- max input retries: 1
- backoff: exponential, low cap

## Output Contract

Always return:

- `project`
- `agents[]` (id, provider, finalStatus, completionTs)
- `messages[]` (final assistant summaries or explicit missing reason)
- `errors[]`
- `timings` (start/end/duration)

## Safety Rules

- never auto-delete failed projects unless explicit force cleanup
- keep attach/debug pointers for failed agents
- prefer internals messages over raw tmux output parsing
