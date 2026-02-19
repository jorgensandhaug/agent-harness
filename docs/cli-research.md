# CLI Research: Agent Harness API Client

Date: 2026-02-19

## Scope and method

This research covers:

1. Full HTTP API contract in this repository.
2. Bun/TypeScript CLI framework options.
3. Command patterns from comparable CLIs (`gh`, `flyctl`, `railway`).
4. Distribution options.
5. UX patterns for output, interactivity, streaming, and errors.
6. Recommended project structure for implementation.

Sources include local route/type code and external docs/source repositories. External links are listed at the end.

## 1) Full API surface map

Base API prefix: `/api/v1`  
Transport: JSON (except SSE + `/inspect` HTML)

### 1.1 Global behaviors

`/api/v1/*` behavior:

- CORS enabled.
- Response header `X-Agent-Harness-Mode` is set to `full` or `compact`.
- `compact` query handling:
  - `?compact=true` or `?compact=1` => compact mode.
  - Any other value => full mode.

Auth behavior:

- If server auth token is configured, all `/api/v1/*` endpoints require `Authorization: Bearer <token>`, except `/api/v1/health`.
- Errors:
  - `401 { "error": "UNAUTHORIZED", "message": "Missing bearer token" }`
  - `401 { "error": "UNAUTHORIZED", "message": "Invalid bearer token" }`

tmux guard:

- All `/api/v1/projects/*` endpoints check tmux availability first.
- If unavailable:  
  `503 { "error": "TMUX_UNAVAILABLE", "message": "tmux is not installed or not accessible" }`

Global fallback errors:

- `404 { "error": "NOT_FOUND", "message": "Route not found" }`
- `500 { "error": "INTERNAL_ERROR", "message": "<message>" }`

Manager error mapping (used across many routes):

- `PROJECT_NOT_FOUND` => `404`
- `PROJECT_EXISTS` => `409`
- `AGENT_NOT_FOUND` => `404`
- `UNKNOWN_PROVIDER` => `400` (`INVALID_REQUEST`)
- `PROVIDER_DISABLED` => `400` (`INVALID_REQUEST`)
- `SUBSCRIPTION_NOT_FOUND` => `400` (`INVALID_REQUEST`)
- `SUBSCRIPTION_PROVIDER_MISMATCH` => `400` (`INVALID_REQUEST`)
- `SUBSCRIPTION_INVALID` => `400` (`INVALID_REQUEST`)
- `TMUX_ERROR` => `500`

---

### 1.2 Core response types (from source)

```ts
type AgentStatus = "starting" | "idle" | "processing" | "waiting_input" | "error" | "exited";

type Project = {
  name: string;
  cwd: string;
  tmuxSession: string;
  agentCount: number;
  createdAt: string; // ISO
};

type PublicAgentCallback = {
  url: string;
  discordChannel?: string;
  sessionKey?: string;
  extra?: Record<string, string>;
};

// Full agent response omits callback.token (redacted)
type PublicAgent = {
  id: string;
  project: string;
  provider: string;
  status: AgentStatus;
  brief: string[];
  task: string;
  windowName: string;
  tmuxTarget: string;
  attachCommand: string;
  subscriptionId?: string;
  callback?: PublicAgentCallback;
  providerRuntimeDir?: string;
  providerSessionFile?: string;
  createdAt: string;
  lastActivity: string;
  lastCapturedOutput: string;
};
```

---

### 1.3 Endpoints

#### Health

`GET /api/v1/health`

- Auth: not required (even when auth enabled)
- Response `200`:

```json
{
  "uptime": 123,
  "projects": 2,
  "agents": 5,
  "tmuxAvailable": true,
  "version": "0.1.0"
}
```

#### Projects

`POST /api/v1/projects`

- Body:

```json
{
  "name": "my-project",
  "cwd": "/abs/path"
}
```

- Validation:
  - `name`: 1-64 chars, `^[a-zA-Z0-9_-]+$`
  - `cwd`: non-empty string
- Success: `201 { "project": Project }`
- Common errors:
  - `400 INVALID_REQUEST`
  - `409 PROJECT_EXISTS`
  - `500 TMUX_ERROR`

`GET /api/v1/projects`

- Success: `200 { "projects": Project[] }`

`GET /api/v1/projects/:name`

- Success:

```json
{
  "project": { "...": "Project" },
  "agents": [
    {
      "id": "abcd1234",
      "provider": "codex",
      "status": "processing",
      "tmuxTarget": "ah-...:codex-..."
    }
  ]
}
```

- Error: `404 PROJECT_NOT_FOUND`

`DELETE /api/v1/projects/:name`

- Success: `204` no body
- Errors: `404 PROJECT_NOT_FOUND`, `500 TMUX_ERROR`

#### Agents

Base path: `/api/v1/projects/:name/agents`

`POST /api/v1/projects/:name/agents`

- Body:

```json
{
  "provider": "codex",
  "task": "do work",
  "model": "gpt-5",
  "subscription": "sub-id",
  "callback": {
    "url": "https://your-host/harness-webhook",
    "token": "optional-write-only",
    "discordChannel": "alerts",
    "sessionKey": "session-main",
    "extra": { "key": "value" }
  }
}
```

- Notes:
  - Currently only `provider: "codex"` is allowed by route guard.
  - Unsupported provider returns `400` with a nonstandard shape:
    - `{ "error": "Only the codex provider is currently supported..." }`
- Success `201`:
  - Full mode: `{ "agent": PublicAgent }`
  - Compact mode (`?compact=true|1`):

```json
{
  "agent": {
    "id": "abcd1234",
    "status": "starting",
    "tmuxTarget": "ah-...:codex-...",
    "attachCommand": "tmux attach -t ah-..."
  }
}
```

`GET /api/v1/projects/:name/agents`

- Success `200`:
  - Full mode: `{ "agents": PublicAgent[] }`
  - Compact mode:

```json
{
  "agents": [
    {
      "id": "abcd1234",
      "provider": "codex",
      "status": "processing",
      "tmuxTarget": "ah-...:codex-...",
      "brief": ["latest assistant line", "..."]
    }
  ]
}
```

`GET /api/v1/projects/:name/agents/:id`

- Success `200`:
  - Full mode:

```json
{
  "agent": { "...": "PublicAgent" },
  "status": "processing",
  "lastOutput": "..."
}
```

  - Compact mode:

```json
{
  "agent": {
    "id": "abcd1234",
    "status": "processing",
    "tmuxTarget": "ah-...:codex-...",
    "brief": ["latest line"]
  }
}
```

`POST /api/v1/projects/:name/agents/:id/input`

- Body: `{ "text": "follow-up prompt" }`
- Success: `202 { "delivered": true }`

`GET /api/v1/projects/:name/agents/:id/output?lines=<1..10000>`

- Query:
  - `lines` optional integer.
  - Invalid `lines` is silently ignored (falls back to default capture lines), not a 400.
- Success:

```json
{
  "output": "...captured pane text...",
  "lines": 187
}
```

`GET /api/v1/projects/:name/agents/:id/messages?limit=<1..500>&role=<all|user|assistant|system|developer>`

- Success `200`:

```json
{
  "provider": "codex",
  "source": "internals_codex_jsonl",
  "messages": [
    {
      "id": null,
      "ts": "2026-02-17T00:00:01.000Z",
      "role": "assistant",
      "text": "hello",
      "finishReason": null,
      "sourceRecord": "event_msg:agent_message"
    }
  ],
  "lastAssistantMessage": { "...": "AgentMessage|null" },
  "totalMessages": 10,
  "truncated": false,
  "parseErrorCount": 0,
  "warnings": []
}
```

`GET /api/v1/projects/:name/agents/:id/messages/last`

- Success `200`:
  - Full mode:

```json
{
  "provider": "codex",
  "source": "internals_codex_jsonl",
  "lastAssistantMessage": { "...": "AgentMessage|null" },
  "parseErrorCount": 0,
  "warnings": []
}
```

  - Compact mode: `{ "text": "latest assistant text or null" }`

`POST /api/v1/projects/:name/agents/:id/abort`

- Success: `202 { "sent": true }`

`DELETE /api/v1/projects/:name/agents/:id`

- Success: `204` no body

For all `:id` agent endpoints, common not-found error:  
`404 { "error": "AGENT_NOT_FOUND", "message": "Agent '<id>' not found in project '<name>'" }`

#### Debug

`GET /api/v1/projects/:name/agents/:id/debug`

- Success `200`:

```json
{
  "debug": {
    "poll": {
      "lastPollAt": "2026-02-18T...",
      "pollIntervalMs": 1000,
      "captureLines": 500,
      "lastCaptureBytes": 12345,
      "lastDiffBytes": 456
    },
    "tmux": {
      "paneDead": false,
      "paneCurrentCommand": "codex"
    },
    "parser": {
      "lastParsedStatus": "processing",
      "lastProviderEventsCount": 4,
      "lastWarnings": []
    },
    "stream": {
      "lastEventId": "evt-42",
      "emittedCounts": { "output": 12, "status_changed": 3 }
    },
    "statusTransitions": [],
    "errors": []
  }
}
```

- Errors:
  - `404 AGENT_NOT_FOUND`
  - `404 NOT_FOUND` (`Debug state not available for this agent`)

#### Events (SSE)

`GET /api/v1/projects/:name/events?since=evt-123`
`GET /api/v1/projects/:name/agents/:id/events?since=evt-123`

- Content type: SSE stream.
- Frame shape:
  - `id`: `evt-N`
  - `event`: normalized event type (for heartbeats: `"heartbeat"`)
  - `data`: JSON string for event payload; heartbeat has empty data.
- `since` behavior:
  - Accepted only if matching `/^evt-\d+$/`.
  - If valid, server replays matching events after that id from in-memory history.
- Heartbeat every 15s.

Normalized event union includes:

- `agent_started`
- `status_changed`
- `output`
- `tool_use`
- `tool_result`
- `error`
- `agent_exited`
- `input_sent`
- `permission_requested`
- `question_asked`
- `unknown`

Errors:

- Project stream: `404 PROJECT_NOT_FOUND` if project missing.
- Agent stream: `404 AGENT_NOT_FOUND` if agent missing.

#### Subscriptions

`GET /api/v1/subscriptions`

- Success `200`:

```json
{
  "subscriptions": [
    {
      "id": "sub-id",
      "provider": "codex",
      "mode": "chatgpt",
      "sourceDir": "/path",
      "valid": true,
      "reason": null,
      "metadata": { "hasTokens": true },
      "source": "configured",
      "locator": { "kind": "sourceDir", "path": "/path" },
      "subscription": { "...": "full subscription config object" },
      "provenance": { "...": "discovery/config metadata" }
    }
  ]
}
```

- Route filters out providers not in allowlist (`codex` currently).

#### Webhook diagnostics

`GET /api/v1/webhook/status`

- If webhook client absent:

```json
{
  "configured": false,
  "reason": "webhook not configured"
}
```

- If configured:

```json
{
  "configured": true,
  "status": {
    "enabled": true,
    "startedAt": "2026-02-18T00:00:00.000Z",
    "config": {
      "url": "http://your-host/harness-webhook",
      "tokenConfigured": true,
      "events": ["agent_completed", "agent_error", "agent_exited"],
      "safetyNet": {
        "enabled": false,
        "intervalMs": 30000,
        "stuckAfterMs": 180000,
        "stuckWarnIntervalMs": 300000
      },
      "globalFallbackConfigured": true
    },
    "counters": {
      "attempts": 0,
      "successes": 0,
      "failures": 0,
      "retries": 0,
      "manualTests": 0,
      "safetyNetCycles": 0,
      "safetyNetWarnings": 0
    },
    "lastAttemptAt": null,
    "lastSuccessAt": null,
    "lastFailureAt": null,
    "lastSafetyNetWarningAt": null,
    "trackedAgents": {
      "lifecycle": 0,
      "deliveredTerminal": 0,
      "stuckWarned": 0
    },
    "recentAttempts": []
  }
}
```

`POST /api/v1/webhook/test`

- Optional JSON body fields:
  - `event`, `project`, `agentId`, `provider`, `status`, `lastMessage`
  - `url`, `token`, `discordChannel`, `sessionKey`, `extra`
- If webhook not configured:  
  `400 { "error": "WEBHOOK_NOT_CONFIGURED", "message": "webhook is not configured" }`
- Success:

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "payload": {
      "event": "agent_completed",
      "project": "__inspect_test__",
      "agentId": "__inspect_test__",
      "provider": "inspect",
      "status": "idle",
      "lastMessage": "manual inspector webhook test",
      "timestamp": "2026-02-18T..."
    }
  },
  "status": { "...": "WebhookClientStatus" }
}
```

`POST /api/v1/webhook/probe-receiver`

- Optional JSON body: `{ "baseUrl": "http://host:port" }`
- If webhook not configured: same `400 WEBHOOK_NOT_CONFIGURED`.
- If base URL cannot be derived:  
  `400 { "error": "INVALID_WEBHOOK_URL", "message": "...", "webhookUrl": "..." }`
- Success:

```json
{
  "baseUrl": "http://your-host.test",
  "health": {
    "url": "http://your-host.test/health",
    "ok": true,
    "status": 200,
    "bodySnippet": "{\"ok\":true}",
    "error": null
  },
  "harnessWebhook": {
    "url": "http://your-host.test/harness-webhook",
    "ok": false,
    "status": 400,
    "bodySnippet": "{\"error\":\"invalid_payload\"}",
    "error": null
  }
}
```

#### Inspect page

`GET /inspect` returns HTML UI (not JSON API).

---

### 1.4 Related HTTP service in repo (separate process)

`src/webhook-receiver.ts` exposes:

- `GET /health` => `{ "ok": true }`
- `POST /harness-webhook`
  - Optional bearer token check.
  - Validates payload with strict schema.
  - Errors:
    - `401 { "error": "unauthorized" }`
    - `400 { "error": "invalid_json" }`
    - `400 { "error": "invalid_payload", "issues": [...] }`
  - Success: `{ "ok": true }`

This is not the main agent-harness API, but CLI diagnostics can optionally target it for webhook troubleshooting.

## 2) CLI framework options for Bun/TypeScript

### 2.1 Evaluated options

- `commander`
- `yargs`
- `citty`
- `cleye`
- `@oclif/core`
- zero dependency (`process.argv` + thin parser)

### 2.2 Compatibility and performance findings (Bun 1.3.9)

All five frameworks ran successfully in Bun for basic command parsing.

Local startup benchmark (`bun <script> --help`, simple one-command program):

| Option | Avg startup (ms) | npm unpacked size | Runtime deps | Notes |
|---|---:|---:|---:|---|
| zero-dependency | 13 | n/a | 0 | fastest, but manual UX/parsing burden |
| `citty` | 24 | 24 KB | 0 | very light; uses `node:util.parseArgs` |
| `commander` | 36 | 209 KB | 0 | mature and ergonomic subcommands/help |
| `cleye` | 39 | 62 KB | 2 | light, fewer ecosystem examples |
| `yargs` | 60 | 231 KB | 6 | feature-rich, heavier startup/deps |
| `@oclif/core` | 111 | 412 KB | many | powerful plugin architecture, overkill here |

Compiled binary size with `bun build --compile` in this test:

- `~100 MB` across all options (runtime dominates), so framework choice barely changes compiled artifact size.

### 2.3 Source-level observations

- `commander`: core implementation imports Node built-ins (`node:events`, `node:child_process`, `node:path`, `node:fs`, `node:process`), but worked on Bun.
- `yargs`: Node platform shims import `node:module` and `node:fs`; extensive process/environment usage.
- `citty`: small codebase; argument parser wraps native `node:util.parseArgs`.
- `cleye`: compact parser/help tooling; uses `process.exit` flow in built output.
- `oclif`: broad runtime system (config/plugin/help/perf layers), significantly heavier.

### 2.4 What modern Bun CLIs are using

From package/source inspection:

- `nuxi` bundles/depends on `citty`.
- `create-hono` bundles `commander`.
- `@hono/cli` depends on `commander`.

Conclusion: both `citty` and `commander` are viable and used by active Bun-adjacent tools.

### 2.5 Recommendation

Recommended choice: `commander`.

Why:

- Best balance of maturity, docs, help UX, and subcommand ergonomics for a broad API wrapper.
- Bun compatibility is proven in practice.
- Startup overhead vs `citty` is small in absolute terms for this use case.

Alternative if minimal footprint is the top priority: `citty`.

Not recommended for this CLI:

- `@oclif/core` unless you explicitly need plugin ecosystems and enterprise-scale CLI framework conventions.
- pure zero-dependency for this scope, because command surface and UX complexity are high enough to justify a library.

## 3) CLI patterns from similar API CLIs

### 3.1 `gh` patterns

- Noun-based command tree (`auth`, `repo`, `pr`, `issue`, etc.).
- Strong JSON scripting support:
  - `--json`, `--jq`, `--template`.
- Environment variable support for auth/context:
  - `GH_TOKEN`, `GH_REPO`, `GH_CONFIG_DIR`, `GH_PROMPT_DISABLED`.
- Command discoverability is very high with grouped help topics.

### 3.2 `flyctl` patterns

- App context defaults to local config (`fly.toml`) and can be overridden with app flag (`-a/--app`).
- Commands frequently support machine output (`--json`) along with human-readable output.
- Strong flag-first operation for automation.

### 3.3 `railway` patterns

- Context linking model (`railway link`) binds current directory to project/environment/service.
- Supports token-based auth via env vars (`RAILWAY_TOKEN`, `RAILWAY_API_TOKEN`).
- Supports `--json` and non-interactive-friendly flags.

### 3.4 Pattern takeaway for agent-harness CLI

- Use noun-based top-level commands.
- Support both human and JSON output everywhere practical.
- Provide explicit context model for “current project” in a local file.
- Maintain strict non-interactive behavior in CI while still offering interactive prompts in TTY.

## 4) Proposed CLI command structure (endpoint mapping)

Proposed binary name: `ah` (alias to `agent-harness`).

### 4.1 Global flags/env

- `--api-url` (`AH_API_URL`, default `http://127.0.0.1:7070`)
- `--token` (`AH_AUTH_TOKEN`)
- `--project` (`AH_PROJECT`) for default project context override
- `--json` for raw JSON output
- `--compact` for endpoints that support compact mode
- `--no-color`, `--verbose`, `--quiet`

### 4.2 Commands

| CLI command | HTTP call(s) | Notes |
|---|---|---|
| `ah health` | `GET /api/v1/health` | daemon readiness |
| `ah projects list` | `GET /api/v1/projects` | table/json |
| `ah projects create <name> [--cwd]` | `POST /api/v1/projects` | validates name pattern |
| `ah projects get <name>` | `GET /api/v1/projects/:name` | includes summary agents |
| `ah projects delete <name> [--yes]` | `DELETE /api/v1/projects/:name` | destructive confirm in TTY |
| `ah projects use <name>` | local context write | no API call |
| `ah agents list [--project]` | `GET /api/v1/projects/:name/agents` | optional `--compact` |
| `ah agents create [--project] --task ... [--provider codex] [--model] [--subscription] [callback flags]` | `POST /api/v1/projects/:name/agents` | callback flags map to callback object |
| `ah agents get <agentId> [--project]` | `GET /api/v1/projects/:name/agents/:id` | optional `--compact` |
| `ah agents input <agentId> [--project] --text ...` | `POST /api/v1/projects/:name/agents/:id/input` | return 202 ack |
| `ah agents output <agentId> [--project] [--lines]` | `GET /api/v1/projects/:name/agents/:id/output` | raw pane output |
| `ah agents messages <agentId> [--project] [--limit] [--role]` | `GET /api/v1/projects/:name/agents/:id/messages` | structured messages |
| `ah agents last <agentId> [--project]` | `GET /api/v1/projects/:name/agents/:id/messages/last` | optional compact text-only |
| `ah agents abort <agentId> [--project]` | `POST /api/v1/projects/:name/agents/:id/abort` | return 202 ack |
| `ah agents delete <agentId> [--project] [--yes]` | `DELETE /api/v1/projects/:name/agents/:id` | destructive confirm |
| `ah agents debug <agentId> [--project]` | `GET /api/v1/projects/:name/agents/:id/debug` | diagnostic payload |
| `ah events project [--project] [--since evt-N]` | `GET /api/v1/projects/:name/events` (SSE) | stream with resume |
| `ah events agent <agentId> [--project] [--since evt-N]` | `GET /api/v1/projects/:name/agents/:id/events` (SSE) | focused stream |
| `ah subscriptions list` | `GET /api/v1/subscriptions` | validity + metadata |
| `ah webhook status` | `GET /api/v1/webhook/status` | config + counters |
| `ah webhook test [flags]` | `POST /api/v1/webhook/test` | ad hoc payload testing |
| `ah webhook probe [--base-url]` | `POST /api/v1/webhook/probe-receiver` | receiver diagnostics |
| `ah raw <method> <path>` | arbitrary | escape hatch for new routes |

## 5) Config and auth recommendation

### 5.1 Config files

Use two layers:

- Global config: `~/.config/agent-harness/cli.json`
  - `apiUrl`, `token`, output defaults.
- Project-local context: `.agent-harness/context.json` in cwd/repo root
  - `project` default for that working directory.

### 5.2 Precedence

`flag > env > local context > global config > built-in default`

### 5.3 Auth

- Primary: bearer token via `AH_AUTH_TOKEN` or `--token`.
- Optional `ah auth login --token` writes token to global config (0600 file permissions).
- Keep token out of project-local context files.

### 5.4 Context UX

- `ah projects use <name>` sets local default project.
- Commands requiring a project should resolve in order:
  1. `--project`
  2. `AH_PROJECT`
  3. local context file
  4. error with actionable message.

## 6) Distribution and installation strategy

### 6.1 Options

| Option | Pros | Cons |
|---|---|---|
| `bun install --global <pkg>` | native Bun flow, simple for Bun users | requires Bun runtime |
| `npm install -g <pkg>` | familiar Node ecosystem path | if CLI depends on Bun runtime/shebang, Node-only users fail |
| `bun build --compile` binary releases | no runtime dependency for users | large binaries (~100 MB), per-platform build/release pipeline |

### 6.2 Recommendation

Ship two channels:

1. npm package for Bun/Node developer workflows (`bunx`/`npx`/global install).
2. Precompiled binaries for frictionless install in environments without Bun.

Pragmatic sequence:

1. Launch npm package first.
2. Add compiled binaries once command surface stabilizes.

## 7) UX recommendations

### 7.1 Output formatting

- Default human mode:
  - lists => aligned table.
  - single resources => key/value blocks.
- `--json` should print raw response payload (no extra prose).
- Use color sparingly:
  - success/idle green, processing blue, warning yellow, error red.
- Respect `NO_COLOR` and non-TTY defaults.

### 7.2 Interactive vs non-interactive

- In TTY:
  - prompt for missing non-sensitive inputs only when safe.
  - confirm destructive operations unless `--yes`.
- In non-TTY:
  - never prompt.
  - fail fast with explicit next action.

### 7.3 Streaming output (SSE)

For `ah events ...`:

- Parse SSE frames incrementally.
- Ignore/display heartbeat minimally.
- Persist last event id in memory and reconnect with `?since=<lastEventId>` on transient network loss.
- Provide `--json` to emit event JSON objects line-by-line (JSONL).
- Provide human formatter grouped by event type.

### 7.4 Error and help patterns

- Error format:
  - first line: concise failure.
  - include HTTP status + API `error` code + API message when available.
  - include actionable fix hint.
- Exit codes:
  - `0` success
  - `2` CLI usage/validation error
  - `3` auth error
  - `4` not found/resource mismatch
  - `5` server/internal/tmux error

## 8) Project structure recommendation

### 8.1 Options

`cli/` inside this repo:

- Pros:
  - single source of truth with server/API code.
  - easier to keep in lockstep with route changes.
  - easier local dev and shared test fixtures.
- Cons:
  - server and client release cadence coupled unless explicitly separated.

Separate package/repo:

- Pros:
  - independent versioning and release cycle.
  - clean consumer-facing package boundaries.
- Cons:
  - higher API drift risk.
  - duplicated CI/versioning overhead.

### 8.2 Recommendation

Use an in-repo workspace package (`packages/cli` preferred over top-level `cli/`), with independent package versioning.

Reason:

- Keeps implementation near API internals while preserving a clean package boundary.
- Minimizes drift now; keeps future extraction possible if needed.

## 9) Gotchas and considerations discovered

- Provider allowlist currently permits only `codex` in API routes.
- Unsupported provider error shape is inconsistent (`error` string only, no `message`).
- `compact` mode only changes selected endpoints (`agents` create/get/list and `messages/last`).
- `output?lines=` ignores invalid values instead of returning validation errors.
- SSE replay uses in-memory history and event IDs generated in-process (`evt-N`), so replay continuity does not survive daemon restarts.
- Health `version` is hardcoded (`0.1.0`) in route code.
- Callback tokens are write-only: accepted on create, redacted in API responses.
- `/api/v1/projects/*` routes depend on tmux guard and can return `503` before normal handler logic.

## Sources

### Local source files (primary API contract)

- `src/api/app.ts`
- `src/api/projects.ts`
- `src/api/agents.ts`
- `src/api/events.ts`
- `src/api/debug.ts`
- `src/api/health.ts`
- `src/api/subscriptions.ts`
- `src/api/webhook.ts`
- `src/api/agent-response.ts`
- `src/api/errors.ts`
- `src/session/manager.ts`
- `src/session/messages.ts`
- `src/session/types.ts`
- `src/events/types.ts`
- `src/events/bus.ts`
- `src/debug/tracker.ts`
- `src/providers/allowed.ts`
- `src/webhook/client.ts`
- `src/webhook-receiver.ts`
- `src/config.ts`
- `src/cli.ts`
- `src/api/app.integration.test.ts`
- `src/api/messages.test.ts`
- `src/api/webhook.test.ts`

### External references

- Bun install global docs: https://bun.sh/docs/pm/global-install
- Bun single-file executable docs: https://bun.sh/docs/bundler/executables
- Bun compile option docs: https://bun.sh/docs/bundler
- npm global install docs: https://docs.npmjs.com/cli/v10/commands/npm-install
- GitHub CLI manual: https://cli.github.com/manual
- GitHub CLI environment vars: https://cli.github.com/manual/gh_help_environment
- GitHub CLI formatting options: https://cli.github.com/manual/gh_help_formatting
- Fly docs (app config and command patterns): https://fly.io/docs/flyctl/
- Fly deploy docs (flag patterns): https://fly.io/docs/flyctl/deploy/
- Railway CLI docs: https://docs.railway.com/cli
- Railway CLI environment vars: https://docs.railway.com/reference/cli-api
- Commander repository: https://github.com/tj/commander.js
- yargs repository: https://github.com/yargs/yargs
- citty repository: https://github.com/unjs/citty
- cleye repository: https://github.com/privatenumber/cleye
- oclif core repository: https://github.com/oclif/core
- nuxi package: https://www.npmjs.com/package/nuxi
- create-hono package: https://www.npmjs.com/package/create-hono
- @hono/cli package: https://www.npmjs.com/package/@hono/cli
