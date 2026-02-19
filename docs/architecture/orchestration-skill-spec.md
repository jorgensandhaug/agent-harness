# OpenClaw Harness Orchestration Skill Spec

Date: 2026-02-18  
Status: proposed

## Scope
Define an OpenClaw skill (`SKILL.md`) that teaches an AI assistant to orchestrate `agent-harness` via HTTP API.

Skill responsibilities:
- create/list/delete projects
- spawn/manage agents
- monitor progress via SSE + polling fallback
- read structured messages
- consume webhook completion signals
- dispatch agents in parallel
- recover from API/runtime failures

No implementation here. Spec only.

## Source API contract (current harness)

Base prefix: `/api/v1`

### Project endpoints
- `POST /projects` -> create project
- `GET /projects` -> list projects
- `GET /projects/:name` -> project details + agent summary
- `DELETE /projects/:name` -> delete project

### Agent endpoints
- `POST /projects/:name/agents` -> spawn agent
- `GET /projects/:name/agents` -> list agents
- `GET /projects/:name/agents/:id` -> full agent + status + lastOutput
- `POST /projects/:name/agents/:id/input` -> send prompt/input
- `GET /projects/:name/agents/:id/output?lines=N` -> pane capture
- `GET /projects/:name/agents/:id/messages?limit=&role=` -> structured internals messages
- `GET /projects/:name/agents/:id/messages/last` -> latest assistant message
- `POST /projects/:name/agents/:id/abort` -> send interrupt
- `DELETE /projects/:name/agents/:id` -> terminate/remove agent

### Event endpoints
- `GET /projects/:name/events?since=evt-N` (SSE, all agents)
- `GET /projects/:name/agents/:id/events?since=evt-N` (SSE, one agent)

### Health/debug endpoints
- `GET /api/v1/health` (never bearer-protected)
- `GET /projects/:name/agents/:id/debug` (optional diagnostics)

### Auth model
- If configured, send `Authorization: Bearer <token>` on all `/api/v1/*` except health.

## Skill deliverable shape

Skill directory target (OpenClaw skill repo):
- `SKILL.md` (primary instruction file)
- optional reference note for endpoint quick map

`SKILL.md` must include:
- required inputs
- default workflow
- branching for single-agent vs parallel-agent jobs
- webhook-first completion flow with polling fallback
- explicit error recovery playbook

## Required runtime inputs to skill
- `HARNESS_BASE_URL` (example: `http://127.0.0.1:7070/api/v1`)
- `HARNESS_BEARER_TOKEN` (optional)
- `PROJECT_NAME` or deterministic prefix rule
- `PROJECT_CWD`
- `PROVIDER` (`claude-code|codex|pi|opencode`)
- `TASK`

Optional:
- `MODEL`
- `PARALLEL_COUNT`
- `WEBHOOK_MODE` (`enabled|disabled`)
- `TIMEOUTS` (`spawnTimeout`, `completionTimeout`, `idleGrace`)

## Canonical orchestration model

### Agent status semantics
Terminal states:
- `idle` (completed)
- `error`
- `exited`

Non-terminal states:
- `starting`
- `processing`
- `waiting_input`

### Event stream usage
- Prefer project-level SSE for multi-agent jobs.
- Track last `event.id` and reconnect with `since=<lastId>`.
- Use heartbeat events only as connection liveness signal.

### Message retrieval usage
- Use `/messages/last` for completion summaries.
- Use `/messages?role=assistant&limit=N` when summary missing.
- Avoid parsing tmux output when internals endpoint is available.

## Core execution flows

### Flow A: single-agent task
1. Create project (`POST /projects`).
2. Spawn agent (`POST /projects/:name/agents`) with provider/task/model.
3. Open SSE stream (`GET /projects/:name/agents/:id/events`).
4. Wait for terminal status via `status_changed` events.
5. Read final assistant output (`GET /messages/last`).
6. Return result upstream.
7. Cleanup policy:
- keep agent/project for inspection when failed
- delete on success when caller requests ephemeral mode

### Flow B: parallel dispatch
1. Ensure one project exists.
2. Spawn N agents in parallel under same project.
3. Subscribe once to project SSE (`/projects/:name/events`).
4. Maintain in-memory map per agent:
- current status
- last event id
- completion timestamp
- error marker
5. On each terminal transition, fetch `/messages/last` for that agent.
6. Complete when all agents terminal or global timeout reached.
7. For timed-out agents: abort -> short grace wait -> delete (if still non-terminal).

### Flow C: webhook-assisted completion
When webhook receiver is available:
1. Harness emits outbound webhook on `processing -> idle|error|exited`.
2. Receiver posts event to OpenClaw system channel.
3. Skill treats webhook event as fast-path trigger to fetch `/messages/last`.
4. Polling/SSE remains fallback for missed/late webhooks.

## Example API call sequences (spec-level)

### Sequence 1: create + run + read result
1. `POST /projects`
- request: `{ "name": "wave6-docs", "cwd": "/home/user/repos/agent-harness" }`
- success: `201 { "project": {...} }`
2. `POST /projects/wave6-docs/agents`
- request: `{ "provider": "codex", "task": "Summarize X", "model": "..." }`
- success: `201 { "agent": { "id": "a1b2c3d4", ... } }`
3. `GET /projects/wave6-docs/agents/a1b2c3d4/events` (SSE)
- observe `status_changed` to `processing`, then terminal status
4. `GET /projects/wave6-docs/agents/a1b2c3d4/messages/last`
- success: `{ "lastAssistantMessage": { "text": "..." } }`

### Sequence 2: parallel 3-agent fanout
1. `POST /projects`
2. 3x `POST /projects/:name/agents` (parallel)
3. `GET /projects/:name/events` (single SSE channel)
4. On each terminal event, call `GET /projects/:name/agents/:id/messages/last`
5. If any agent stuck beyond timeout:
- `POST /projects/:name/agents/:id/abort`
- fallback `DELETE /projects/:name/agents/:id`

### Sequence 3: SSE reconnect after drop
1. Persist latest `evt-<n>`.
2. reconnect `GET /projects/:name/events?since=evt-<n>`.
3. replay missed events from event bus history.
4. if replay gap suspected, reconcile each agent via `GET /projects/:name/agents/:id`.

## Error model and recovery policy

### HTTP/API errors
- `400 INVALID_REQUEST`: fix payload or provider name; do not blind retry.
- `401 UNAUTHORIZED`: refresh/fetch token; retry once.
- `404 PROJECT_NOT_FOUND|AGENT_NOT_FOUND`: reconcile local cache, recreate if needed.
- `409 PROJECT_EXISTS`: reuse existing project or generate new deterministic suffix.
- `500 TMUX_ERROR|INTERNAL_ERROR`: bounded retry with backoff; if persistent mark task failed.
- `503 TMUX_UNAVAILABLE`: fail fast; requires host remediation.

### Runtime/control-plane failures
- SSE disconnect: reconnect with `since` cursor.
- Missing webhook: fallback to SSE/poll path.
- Agent stuck `processing`: send input nudge only if workflow expects prompt; otherwise abort.
- Agent stuck `starting`: hard timeout -> delete + respawn once.
- Message parse warnings: use `/output` snapshot as degraded fallback.

### Retry guardrails
- max create-project retries: 2
- max create-agent retries: 2 per agent
- max input retries: 1
- backoff: exponential, capped low (fast interactive system)

## Parallel dispatch policy
- Default parallelism: `min(4, requested)` unless caller overrides.
- Use provider diversity only when requested.
- Keep one SSE stream per project, not per agent, for scale.
- Track completion quorum:
- `all` mode: wait all terminal
- `any` mode: return first successful idle, then optionally abort remainder

## Webhook event handling contract
Receiver payload shape expected by skill:
- `event`: `agent_completed|agent_error|agent_exited`
- `project`
- `agentId`
- `provider`
- `status`
- `lastMessage`
- `timestamp`

Webhook handling requirements:
- verify bearer token on inbound receiver endpoint
- dedupe by `project + agentId + event + timestamp`
- treat webhook as hint, then confirm agent state via API read

## Skill output contract
Skill must return structured result with:
- `project`
- `agents[]` with final status per agent
- `messages[]` (final assistant summaries)
- `errors[]` (if any)
- `timings` (start/end/duration)

## Safety and cleanup rules
- never delete project automatically when any agent failed unless caller requested force cleanup
- always surface attach/debug pointers on failure
- prefer keeping failed agent for operator inspection

## Acceptance criteria
- assistant can run full lifecycle without manual API docs lookup
- parallel dispatch works with single SSE stream + per-agent reconciliation
- webhook and polling paths both supported
- recovery behavior deterministic for 400/401/404/409/500/503
- final response always includes per-agent terminal state and final assistant message or explicit reason missing
