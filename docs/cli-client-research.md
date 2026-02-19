# CLI Client Research for Agent Harness

Date: 2026-02-19  
Author: Codex research pass (no implementation code)

## Scope and notes

- The request references `src/http/`, but this repo currently defines daemon HTTP routes under `src/api/` plus a separate webhook receiver app in `src/webhook-receiver.ts`.
- This document inventories all route handlers found in those files.
- Online framework research covers `commander`, `citty`, `clipanion`, and `yargs`, with explicit consideration for `bun build --compile`.

## 1) Full API endpoint inventory

## 1.1 Cross-cutting API behavior

- Base API prefix: `/api/v1/*` (daemon app).
- CORS enabled for all routes.
- Response header on all `/api/v1/*`: `X-Agent-Harness-Mode: full|compact`.
- Auth:
  - If `auth.token` is configured, bearer auth is required on all `/api/v1/*` except `/api/v1/health`.
  - Missing or invalid token returns `401 { error: "UNAUTHORIZED", message: ... }`.
- tmux guard:
  - Applied to `/api/v1/projects/*`.
  - If tmux unavailable, returns `503 { error: "TMUX_UNAVAILABLE", message: ... }`.
- Global fallback:
  - Unknown route: `404 { error: "NOT_FOUND", message: "Route not found" }`
  - Unhandled error: `500 { error: "INTERNAL_ERROR", message: ... }`

## 1.2 Daemon API endpoints (`src/api/*`)

| Method | Path | Purpose | Request shape | Success response | Common error responses |
|---|---|---|---|---|---|
| GET | `/api/v1/health` | Health + runtime stats | none | `200 { uptime, projects, agents, tmuxAvailable, version }` | n/a |
| GET | `/api/v1/subscriptions` | List discovered/configured subscriptions (provider-filtered) | none | `200 { subscriptions: [...] }` | `401` if auth enabled |
| POST | `/api/v1/projects` | Create project | `{ name, cwd }` (`name` regex: alnum/`_`/`-`, max 64) | `201 { project }` | `400 INVALID_REQUEST`, `409 PROJECT_EXISTS`, `500 TMUX_ERROR`, `401` |
| GET | `/api/v1/projects` | List projects | none | `200 { projects: [...] }` | `401` |
| GET | `/api/v1/projects/:name` | Get project + agent summaries | path param `name` | `200 { project, agents }` | `404 PROJECT_NOT_FOUND`, `401`, `503` |
| DELETE | `/api/v1/projects/:name` | Delete project (kills tmux session) | path param | `204` (empty body) | `404 PROJECT_NOT_FOUND`, `500 TMUX_ERROR`, `401`, `503` |
| POST | `/api/v1/projects/:name/agents` | Create agent | `{ provider, task, model?, subscription?, callback? }` | `201 { agent }` | `400 INVALID_REQUEST` (validation/subscription/provider mismatch), custom `400` unsupported provider, `404 PROJECT_NOT_FOUND`, `500 TMUX_ERROR`, `401`, `503` |
| GET | `/api/v1/projects/:name/agents` | List agents | query `compact=true|1` optional | `200 { agents: [...] }` (shape differs by compact mode) | `404 PROJECT_NOT_FOUND`, `401`, `503` |
| GET | `/api/v1/projects/:name/agents/:id` | Get single agent | path params, query `compact=true|1` optional | `200 { agent, ... }` | `404 AGENT_NOT_FOUND`, `401`, `503` |
| POST | `/api/v1/projects/:name/agents/:id/input` | Send input text to agent | `{ text }` | `202 { delivered: true }` | `400 INVALID_REQUEST`, `404 AGENT_NOT_FOUND`, `500 TMUX_ERROR`, `401`, `503` |
| GET | `/api/v1/projects/:name/agents/:id/output` | Capture pane output | query `lines` optional (1..10000) | `200 { output, lines }` | `404 AGENT_NOT_FOUND`, `500 TMUX_ERROR`, `401`, `503` |
| GET | `/api/v1/projects/:name/agents/:id/messages` | Read provider-internals structured messages | query `limit` (1..500), `role` in `all|user|assistant|system|developer` | `200 { provider, source, messages, lastAssistantMessage, ... }` | `400 INVALID_REQUEST`, `404 AGENT_NOT_FOUND`, `401`, `503` |
| GET | `/api/v1/projects/:name/agents/:id/messages/last` | Get latest assistant message | query `compact=true|1` optional | full: `200 { provider, source, lastAssistantMessage, parseErrorCount, warnings }`; compact: `200 { text }` | `404 AGENT_NOT_FOUND`, `401`, `503` |
| POST | `/api/v1/projects/:name/agents/:id/abort` | Send interrupt sequence | none | `202 { sent: true }` | `404 AGENT_NOT_FOUND`, `500 TMUX_ERROR`, `401`, `503` |
| DELETE | `/api/v1/projects/:name/agents/:id` | Delete agent window | path params | `204` | `404 AGENT_NOT_FOUND`, `500 TMUX_ERROR`, `401`, `503` |
| GET | `/api/v1/projects/:name/agents/:id/debug` | Debug tracker snapshot | path params | `200 { debug }` | `404 AGENT_NOT_FOUND` or debug `NOT_FOUND`, `401`, `503` |
| GET | `/api/v1/projects/:name/events` | SSE stream for all project agents | query `since=evt-N` optional | SSE (`event` = normalized type, `id` = event id); heartbeat every 15s | `404 PROJECT_NOT_FOUND`, `401`, `503` |
| GET | `/api/v1/projects/:name/agents/:id/events` | SSE stream for one agent | query `since=evt-N` optional | SSE filtered by project+agent; heartbeat every 15s | `404 AGENT_NOT_FOUND`, `401`, `503` |
| GET | `/api/v1/webhook/status` | Webhook client status | none | configured false shape or configured true with status payload | `401` |
| POST | `/api/v1/webhook/test` | Trigger outbound test webhook | optional JSON body with event metadata overrides | `200 { ok, result, status }` | `400 WEBHOOK_NOT_CONFIGURED`, `401` |
| POST | `/api/v1/webhook/probe-receiver` | Probe receiver health and webhook route | optional `{ baseUrl }` | `200 { baseUrl, health, harnessWebhook }` | `400 WEBHOOK_NOT_CONFIGURED` or `INVALID_WEBHOOK_URL`, `401` |
| GET | `/inspect` | Inspector HTML page | none | HTML | public route, outside `/api/v1` |

### Compact mode behavior

- Implemented via query parameter `compact=true|1`.
- Currently affects:
  - `POST /projects/:name/agents`
  - `GET /projects/:name/agents`
  - `GET /projects/:name/agents/:id`
  - `GET /projects/:name/agents/:id/messages/last`

### SSE event types (normalized)

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
- plus stream heartbeat event: `heartbeat`

## 1.3 Separate receiver HTTP routes (`src/webhook-receiver.ts`)

These are for the standalone receiver binary (`agent-harness-receiver`), not the main daemon API:

| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/health` | Receiver health | returns `{ ok: true }` |
| POST | `/harness-webhook` | Receive outbound harness webhook | optional bearer token check; validates payload schema |

---

## 2) Current CLI structure

## 2.1 Existing CLI entrypoint (`src/cli.ts`)

Current command surface:

- `serve` (default if no args): starts daemon (`serveCommand()`).
- `status`: calls `GET http://127.0.0.1:${config.port}/api/v1/health`, prints human-readable status fields.
- `version`: prints harness version.
- `help` / `-h` / `--help`: prints usage.

Behavior notes:

- Unknown command exits non-zero and prints usage.
- `status` uses 2s timeout and exits non-zero when daemon is down/unhealthy.

## 2.2 Packaging

- Main binary build: `bun build --compile src/cli.ts --outfile agent-harness`.
- Receiver build: `bun build --compile src/webhook-receiver.ts --outfile agent-harness-receiver`.
- Current CLI parsing is manual `if`/`else` branching.

---

## 3) Framework comparison for Bun + TypeScript

## 3.1 What Bun `--compile` implies

From Bun docs:

- `bun build --compile` bundles app + runtime into a standalone executable.
- Some Bun CLI runtime flags are unsupported in compiled binaries.
- Dynamic runtime-loaded assets need explicit inclusion (`--asset-naming`, plugins/copy plugins) if not statically imported.

Implication for CLI framework choice:

- Prefer frameworks with static imports and minimal runtime file system assumptions.
- Keep command modules statically imported or use Bun-supported code-splitting patterns intentionally.

## 3.2 Framework capability snapshot

Versions from npm registry on 2026-02-19:

- `commander` `14.0.3`
- `citty` `0.2.1`
- `clipanion` `4.0.0-rc.4`
- `yargs` `18.0.0`

| Framework | CLI style | TS ergonomics | Dependency footprint | Bun `--compile` smoke result | Notes |
|---|---|---|---|---|---|
| commander | chainable builder, nested commands | strong typings included | low (no runtime deps in npm metadata) | pass | very mature, large ecosystem, straightforward subcommand trees |
| citty | `defineCommand` object model, `subCommands` map | TS-first API | very low | pass | minimal and clean; smaller ecosystem/docs than commander |
| clipanion | class-based commands, static `paths` | strong type model | low (`typanion`) | pass | powerful but more ceremony and steeper learning curve |
| yargs | builder + command modules, parser-rich | strong TS support | higher (multiple deps) | pass | feature-rich but heavier and slower cold start in quick tests |

## 3.3 Empirical compile smoke test (local)

I ran minimal nested command apps in a temp folder, compiled each with Bun, and executed `projects list`.

Result:

- `commander`: compile/run ok
- `citty`: compile/run ok
- `clipanion`: compile/run ok
- `yargs`: compile/run ok

Rough startup average over 8 runs (single machine, non-rigorous):

- `citty`: ~19ms
- `commander`: ~22ms
- `clipanion`: ~30ms
- `yargs`: ~50ms

Interpretation:

- All 4 are viable with Bun compile for this use case.
- `yargs` is the heaviest option in both dependency tree and startup cost.

---

## 4) Recommended approach

Recommendation: use `commander` for the client CLI.

Why:

- Best risk-adjusted maturity and documentation for a production CLI.
- Clean nested command structure that matches resource-oriented API (`projects`, `agents`, `events`, etc.).
- Works cleanly with Bun compile in local smoke tests.
- Low dependency surface relative to alternatives.
- Easy to add an escape-hatch raw command (`ah api ...`) similar to `gh api`.

Suggested architecture:

- `src/cli/main.ts`: root command, global flags/options.
- `src/cli/http-client.ts`: typed fetch wrapper (base URL, auth header, retries for transient failures).
- `src/cli/commands/*.ts`: one module per resource group.
- `src/cli/output/*.ts`: table/json/plain renderers.
- `src/cli/sse.ts`: reusable SSE reader with resume (`since`) support.

---

## 5) Proposed command structure

## 5.1 Top-level shape

```text
ah
  daemon
    serve
    status
  health
  projects
    list
    create
    get
    delete
  agents
    list
    create
    get
    input
    output
    messages
    last
    abort
    delete
  events
    stream
  subscriptions
    list
  webhook
    status
    test
    probe
  api
    request
  version
```

## 5.2 Direct command-to-endpoint mapping

| Command | HTTP |
|---|---|
| `ah health` | `GET /api/v1/health` |
| `ah projects list` | `GET /api/v1/projects` |
| `ah projects create <name> --cwd <path>` | `POST /api/v1/projects` |
| `ah projects get <name>` | `GET /api/v1/projects/:name` |
| `ah projects delete <name>` | `DELETE /api/v1/projects/:name` |
| `ah agents list <project>` | `GET /api/v1/projects/:name/agents` |
| `ah agents create <project> --provider codex --task ... [--model ...] [--subscription ...]` | `POST /api/v1/projects/:name/agents` |
| `ah agents get <project> <agent-id>` | `GET /api/v1/projects/:name/agents/:id` |
| `ah agents input <project> <agent-id> --text ...` | `POST /api/v1/projects/:name/agents/:id/input` |
| `ah agents output <project> <agent-id> [--lines N]` | `GET /api/v1/projects/:name/agents/:id/output` |
| `ah agents messages <project> <agent-id> [--limit N] [--role ...]` | `GET /api/v1/projects/:name/agents/:id/messages` |
| `ah agents last <project> <agent-id>` | `GET /api/v1/projects/:name/agents/:id/messages/last` |
| `ah agents abort <project> <agent-id>` | `POST /api/v1/projects/:name/agents/:id/abort` |
| `ah agents delete <project> <agent-id>` | `DELETE /api/v1/projects/:name/agents/:id` |
| `ah events stream --project <name> [--agent <id>] [--since evt-N]` | `GET /api/v1/projects/:name/events` or `GET /api/v1/projects/:name/agents/:id/events` |
| `ah subscriptions list` | `GET /api/v1/subscriptions` |
| `ah webhook status` | `GET /api/v1/webhook/status` |
| `ah webhook test [flags...]` | `POST /api/v1/webhook/test` |
| `ah webhook probe [--base-url URL]` | `POST /api/v1/webhook/probe-receiver` |
| `ah api request <method> <path>` | direct arbitrary API call escape hatch |

## 5.3 Global flags and env defaults

Proposed global options:

- `--url <base>` default `http://127.0.0.1:7070`
- `--token <bearer>` optional
- `--config <path>` optional client config path
- `--json` machine output mode
- `--compact` request compact API payloads where supported
- `--verbose` / `--quiet`
- `--no-color`

Proposed env:

- `AH_URL`
- `AH_TOKEN`
- `AH_CONFIG`

---

## 6) UX patterns (config, output formatting, streaming)

## 6.1 Config UX

Recommended precedence:

1. explicit flags
2. env vars
3. client config file
4. defaults

Recommended config file path:

- `${XDG_CONFIG_HOME:-$HOME/.config}/agent-harness/cli.json`

Recommended behavior:

- Do not mutate daemon `harness.json` from client commands.
- Support reading daemon default port from local daemon config as a convenience, but keep explicit CLI client config separate.

## 6.2 Output UX

Borrow from `gh` and Docker patterns:

- Human-friendly default for TTY:
  - tables/lists for collection endpoints
  - key-value summary for singleton endpoints
- Machine mode:
  - `--json` returns stable JSON object directly from API when possible
- Filtering:
  - optional `--jq` and/or `--template` can be added later; not required for v1
- Exit codes:
  - `0` success
  - `1` generic failure
  - `2` usage/validation failure
  - map HTTP failures cleanly in stderr (`HTTP 404 AGENT_NOT_FOUND: ...`)

## 6.3 Streaming UX

For `ah events stream`:

- Show concise event line format by default:
  - timestamp, project, agent, event type, summary text
- `--json` emits one JSON object per line (NDJSON style).
- Reconnect strategy:
  - keep last seen `evt-N`
  - on disconnect, reconnect with `?since=...`
- Heartbeat handling:
  - suppress by default
  - optional `--show-heartbeats` for diagnostics
- Filters:
  - `--type` repeated filter client-side on top of server stream
  - agent-level stream when `--agent` is supplied

## 6.4 Safety UX

- Confirmation prompts on destructive commands (`delete`) unless `--yes`.
- `--dry-run` for write commands can print planned request without sending.
- For auth failures, print actionable hint:
  - missing token
  - wrong base URL
  - daemon not running

---

## gh and Docker pattern takeaways for this CLI

- Use resource-first subcommands (`projects`, `agents`, `webhook`) with verb actions (`list`, `create`, `delete`) like `gh` and Docker management commands.
- Keep a raw API escape hatch (`ah api request ...`) similar to `gh api` for unsupported/experimental routes.
- Standardize global flags across all subcommands (output mode, context/base URL, auth).
- Treat one CLI command as potentially multiple API calls when needed (Docker-style abstraction), but keep default commands 1:1 with API routes wherever possible for predictability.

---

## Sources

### Repository sources

- `src/api/app.ts`
- `src/api/health.ts`
- `src/api/subscriptions.ts`
- `src/api/projects.ts`
- `src/api/agents.ts`
- `src/api/events.ts`
- `src/api/debug.ts`
- `src/api/webhook.ts`
- `src/api/inspect.ts`
- `src/api/errors.ts`
- `src/api/compact.ts`
- `src/events/types.ts`
- `src/session/manager.ts`
- `src/cli.ts`
- `src/serve.ts`
- `src/webhook-receiver.ts`
- `package.json`
- `src/api/*.test.ts` and `src/api/*.integration.test.ts` (behavior verification)

### External references

- Bun executable/compile docs: https://bun.com/docs/bundler/executables
- Commander docs: https://github.com/tj/commander.js
- Citty docs: https://unjs.io/packages/citty/
- Clipanion docs: https://mael.dev/clipanion/
- Yargs docs: https://yargs.js.org/
- npm package metadata:
  - https://www.npmjs.com/package/commander
  - https://www.npmjs.com/package/citty
  - https://www.npmjs.com/package/clipanion
  - https://www.npmjs.com/package/yargs
- GitHub CLI manual:
  - root command: https://cli.github.com/manual/gh
  - `gh api`: https://cli.github.com/manual/gh_api
  - formatting: https://cli.github.com/manual/gh_help_formatting
  - issues: https://cli.github.com/manual/gh_issue
  - issue list: https://cli.github.com/manual/gh_issue_list
  - PR list: https://cli.github.com/manual/gh_pr_list
- GitHub REST endpoints:
  - issues: https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28#list-repository-issues
  - pulls: https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#list-pull-requests
- Docker CLI docs:
  - root command reference: https://docs.docker.com/reference/cli/docker/
  - command syntax: https://docs.docker.com/engine/reference/commandline/cli/
  - env vars/config: https://docs.docker.com/engine/reference/commandline/cli/#environment-variables
  - `docker container ls`: https://docs.docker.com/reference/cli/docker/container/ls/
- Docker Engine API:
  - API reference overview: https://docs.docker.com/reference/api/engine/latest/
  - OpenAPI spec (includes endpoint docs and CLI equivalents): https://raw.githubusercontent.com/moby/moby/master/api/swagger.yaml
