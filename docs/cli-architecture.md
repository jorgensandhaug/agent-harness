# Agent Harness CLI Architecture (Yargs)

Date: 2026-02-19

## Goals

- Build a production CLI client (`ah`) for the daemon HTTP API using `yargs`.
- Keep command surface resource-first and predictable.
- Support both human output and machine-readable JSON output.
- Handle auth, network, API, and stream failures with explicit errors and non-zero exits.

## Module structure

```text
src/cli/
  main.ts                     # yargs root, global flags, command registration
  config.ts                   # flags/env/file/default resolution
  http-client.ts              # typed HTTP + SSE helpers + typed errors
  output.ts                   # table/json/key-value/line renderers
  commands/
    daemon.ts                 # daemon serve/status + health shortcut
    projects.ts               # list/create/get/delete
    agents.ts                 # list/create/get/input/output/messages/last/abort/delete
    events.ts                 # SSE stream with reconnect and filters
    subscriptions.ts          # subscriptions list
    webhook.ts                # webhook status/test/probe
    api.ts                    # raw API escape hatch
```

## Command layout (yargs)

- Binary entrypoint: `ah`.
- Global options (available to all commands):
  - `--url <baseUrl>`: daemon URL (default `http://127.0.0.1:7070`)
  - `--token <bearer>`: bearer token
  - `--json`: JSON output mode
  - `--compact`: request compact mode where supported
- Top-level commands:
  - `daemon serve`
  - `daemon status`
  - `health`
  - `projects list|create|get|delete`
  - `agents list|create|get|input|output|messages|last|abort|delete`
  - `events stream`
  - `subscriptions list`
  - `webhook status|test|probe`
  - `api request <method> <path>`

Registration approach:

- `main.ts` builds one shared `yargs` instance and registers each command module via exported `register*Commands(yargs, deps)` helpers.
- `main.ts` has centralized failure handling (`fail` handler) and unhandled rejection handling.
- `strict()` + `demandCommand()` for usage correctness.

## Typed HTTP client interface

`src/cli/http-client.ts` exports:

- `CliHttpClient`: methods per endpoint group (`health`, `projects`, `agents`, `subscriptions`, `webhook`, `api`, `events`).
- `createHttpClient(config)`: constructs a client with:
  - base URL normalization
  - auth header injection
  - compact query parameter support
  - timeout and content-type handling
- `ApiError` type for non-2xx responses:
  - `status`, `code`, `message`, `details`, `url`, `method`
- `NetworkError` type for DNS/timeout/connection failures.

Design details:

- Generic request helper: `requestJson<T>(...)` + `requestEmpty(...)`.
- Safe JSON decode for error bodies; fallback to raw text if non-JSON.
- Strong TypeScript response types for all known endpoints.
- Raw path mode for `api request` that bypasses typed endpoint helpers but still uses shared auth/base URL/error handling.

## Output formatting

`src/cli/output.ts` exports:

- `printJson(value)`
- `printTable(columns, rows)`
- `printKeyValue(entries)`
- `printTextLine(text)`
- `printSuccess(text)` / `printError(text)`

Formatting policy:

- If `--json`: emit JSON only to stdout.
- Otherwise:
  - list endpoints -> tables
  - singleton endpoints -> key/value blocks
  - streaming -> concise event lines
- Errors always to stderr.
- Ensure deterministic column order and null-safe rendering.

## Config resolution

`src/cli/config.ts` owns client config merging with strict precedence:

1. CLI flags
2. Environment variables (`AH_URL`, `AH_TOKEN`, `AH_JSON`, `AH_COMPACT`, `AH_CONFIG`)
3. Client config file (`$XDG_CONFIG_HOME/agent-harness/cli.json` or `$HOME/.config/agent-harness/cli.json`)
4. Defaults

Behavior:

- Missing config file is not an error.
- Invalid config file is a hard error with a precise message.
- URL normalized (trim trailing slash).
- Token trimmed and omitted if empty.

## SSE streaming (events)

`src/cli/commands/events.ts` uses a shared stream reader from `http-client.ts`:

- Connect to:
  - `/api/v1/projects/:name/events`
  - `/api/v1/projects/:name/agents/:id/events` when `--agent` is given.
- Parse SSE frames (`id`, `event`, `data`).
- Track last event id and reconnect automatically with `?since=<last-id>`.
- Reconnect strategy:
  - exponential backoff with cap
  - stop on explicit abort (`SIGINT`/`SIGTERM`)
- Heartbeats:
  - hidden by default
  - shown when `--show-heartbeats`
- Output:
  - human: one line summary with timestamp/project/agent/type/payload summary
  - `--json`: NDJSON (one event object per line)

## Error handling and exit codes

Global mapping:

- `0`: success
- `1`: runtime/API/network failure
- `2`: usage/validation errors

Rules:

- Usage errors are handled by yargs fail handler (`strict` unknown args, missing required args).
- API errors render as:
  - `HTTP <status> <code>: <message>`
- Network errors render actionable hints (daemon down, wrong URL, timeout, auth missing).
- `daemon status` returns non-zero when unhealthy/unreachable.
- `api request` supports custom body/headers and still returns structured error messages.

## Implementation sequence

1. Build core: `config.ts`, `http-client.ts`, `output.ts`, `main.ts`, `daemon.ts`, `api.ts`.
2. Add resource commands: `projects.ts`, `agents.ts`, `subscriptions.ts`, `webhook.ts`.
3. Add streaming command: `events.ts` with reconnect and filtering.
4. Update package scripts and compile target (`dist/ah`).
5. Smoke test against a running daemon:
  - `ah health`
  - `ah projects list`
  - `ah daemon status`
  - `ah events stream --project <name>` (manual interrupt)
