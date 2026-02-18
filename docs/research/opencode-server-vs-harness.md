# OpenCode Server As Harness Replacement

Date: 2026-02-18  
Researcher: Codex (this run)  
OpenCode source inspected at commit: `6eb043a` (`/tmp/opencode-src`)

## TL;DR

OpenCode server can replace a large part of harness (spawn, input, messages, events, abort, permission flow, status stream) **if** we accept OpenCode as runtime.

It cannot replace goals that require native `codex` CLI / `claude` CLI behavior exactly (different runtime, prompts, tool loop, edge semantics). It also has gaps we must wrap:

- no event replay cursor
- status map is active-only (`busy`/`retry`), idle entries removed
- no first-class multi-account-per-provider selection in one server
- security is basic-auth only (no bearer/RBAC)

Best path: **hybrid or adapter layer**, not blind full swap.

---

## What I Verified (Empirical)

All tests run locally on 2026-02-18 with `opencode 1.1.53`.

### 1) API surface + architecture

- `opencode serve` exposes OpenAPI at `/doc` (82 paths in this build).
- Rich APIs exist for sessions, messages, events, permissions, questions, PTY, providers, config, MCP, etc.
- Server/client model is real: TUI talks to HTTP server.

Key sources:

- `packages/opencode/src/server/server.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/opencode/src/server/routes/provider.ts`
- `packages/opencode/src/server/routes/permission.ts`
- `packages/opencode/src/server/routes/question.ts`

### 2) Auth model of OpenCode server

- Server auth is HTTP Basic when `OPENCODE_SERVER_PASSWORD` set.
- Username defaults to `opencode`, override via `OPENCODE_SERVER_USERNAME`.
- No bearer-token auth built-in.
- Health endpoint is auth-protected when password enabled.

Sources:

- `packages/opencode/src/server/server.ts`
- `packages/web/src/content/docs/server.mdx`

### 3) Session and message behavior

- `POST /session/{id}/prompt_async` works and returns `204`.
- `GET /session/{id}/message` returns structured history (`info.role`, typed `parts`).
- `limit` works; `limit=1` returns last message object.
- `POST /session/{id}/abort` works; assistant ends with `MessageAbortedError`.

Sources:

- `packages/opencode/src/server/routes/session.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/prompt.ts`

### 4) Status behavior (important)

- `session.status` values: `busy | retry | idle`.
- `/session/status` only tracks active/non-idle sessions.
- when session becomes idle, entry is deleted (becomes “missing” in map).

Source:

- `packages/opencode/src/session/status.ts`

### 5) Waiting-for-input semantics

- No dedicated `waiting_input` status in session status API.
- Waiting state is represented by pending requests in:
  - `GET /permission`
  - `GET /question`
- During pending permission/question, session status typically remains `busy`.

Sources:

- `packages/opencode/src/server/routes/permission.ts`
- `packages/opencode/src/server/routes/question.ts`
- `packages/opencode/src/permission/next.ts`
- `packages/opencode/src/question/index.ts`

### 6) Event stream quality

- `/event` and `/global/event` are rich and include:
  - message updates/part deltas
  - session status changes
  - permission/question lifecycle
  - session errors, diffs, pty events, etc.
- No event IDs / resume cursor in SSE payloads (no replay from offset).

Source:

- `packages/opencode/src/server/server.ts` (SSE implementation)
- `packages/opencode/src/bus/bus-event.ts` + event registrations

### 7) Credentials and account routing

- Credentials stored in `~/.local/share/opencode/auth.json`.
- Auth schema is map keyed by provider id, one object per provider (`oauth|api|wellknown`).
- For OpenAI OAuth path (Codex plugin), `accountId` is stored and sent as `ChatGPT-Account-Id`.
- No first-class API to choose among multiple OpenAI accounts/orgs per request.

Sources:

- `packages/opencode/src/auth/index.ts`
- `packages/opencode/src/plugin/codex.ts`
- `packages/web/src/content/docs/providers.mdx`

### 8) Multi-subscription isolation test

Tested 2 servers with different `XDG_DATA_HOME`:

- Server A (auth copied): connected `openai, opencode`
- Server B (empty): connected `opencode` only

Conclusion: account/subscription isolation works cleanly by process-level data-home isolation.

### 9) Runtime caveats observed

- Unknown paths are proxied to `https://app.opencode.ai` (web UI fallback route).
- In this environment, file watcher binding logged missing `libstdc++.so.6` but server still ran.
- Updating `/auth/{provider}` may require `/instance/dispose` before provider connectivity reflects in `/provider`.
- Found one error-path inconsistency:
  - `POST /session/{id}/message` can return HTTP 200 with empty body when failure happens early (e.g. explicit unavailable model), while session has only user message.

Sources:

- `packages/opencode/src/server/server.ts` (fallback proxy)
- `packages/opencode/src/server/routes/session.ts` (`stream(...)` implementation)

---

## Fit Against Harness Goals

## 1) Can OpenCode replace tmux parsing + internals scraping?

Yes, for OpenCode runtime itself. You get structured internals directly:

- session status
- typed message history
- part deltas (streaming text/tool)
- permission/question pending state
- session errors

So for OpenCode-backed agents, parsing terminal UI is unnecessary.

## 2) Can it replace Codex CLI + Claude CLI native runtime?

Not exactly.

OpenCode uses its own orchestration loop and provider adapters/plugins. Even when it uses ChatGPT Plus/Pro or Claude Pro/Max OAuth, behavior is not identical to native CLIs.

Implication:

- If requirement is “native CLI ground truth”, keep harness providers for those CLIs.
- If requirement is “single reliable API orchestration”, OpenCode is strong.

## 3) Can it replace harness project/agent abstraction?

Mostly yes with adapter mapping:

- Harness `agent` ~= OpenCode `session`
- Harness `send input` ~= `prompt_async`
- Harness `messages` ~= `/session/{id}/message`
- Harness `abort` ~= `/session/{id}/abort`

Needs adapter logic for:

- named projects/cwds
- stable status normalization (`missing` => idle/completed/failed derived)
- replayable event timeline (persist SSE yourself)

---

## Capability Mapping (Harness vs OpenCode)

| Harness need | OpenCode server | Notes |
|---|---|---|
| Start task | `POST /session`, `POST /session/{id}/prompt_async` | direct |
| Follow-up input | `prompt_async` again | direct |
| Abort | `POST /session/{id}/abort` | direct |
| Delete agent/session | `DELETE /session/{id}` | direct |
| Live status | `/session/status` + `/event` | active-only status map |
| Waiting input | `/permission`, `/question` + status busy | derive in adapter |
| Structured messages | `/session/{id}/message` | direct, typed parts |
| Last assistant message | `/session/{id}/message?limit=1` + role check | easy |
| Event timeline | SSE `/event` or `/global/event` | no built-in replay cursor |
| Security | Basic auth password | no bearer/RBAC |
| Multi-account choice per agent | no native per-request selector | use server-per-account or mutate global auth (unsafe) |
| Native codex/claude cli semantics | no | different runtime |
| Built-in UI | `opencode web` + TUI + attach | yes |

---

## Subscription/Account Strategy If We Use OpenCode

Given OpenCode auth model, reliable design is:

1. One OpenCode server process per subscription/account profile.
2. Each process runs with isolated `XDG_DATA_HOME` (or fully isolated XDG dirs).
3. Harness/router maps API `subscription` -> server base URL.

Avoid global auth mutation (`PUT /auth/...`) for live multi-tenant routing; it is shared mutable state and can race.

---

## Recommended Direction

### Recommendation: Hybrid migration, not hard switch

1. Add an `opencode-server` backend in harness as first-class runtime.
2. Keep native `codex` and `claude-code` providers for “true CLI” mode.
3. Route by provider mode:
   - `mode=open_runtime`: OpenCode backend
   - `mode=native_cli`: existing tmux provider backend
4. Reuse current inspect dashboard but add source labels:
   - `source: opencode_event`
   - `source: opencode_messages_api`
   - `source: native_tmux_parse`

This gives immediate reliability win without losing native compatibility.

---

## If You Want Full Replacement Anyway

Must add these wrappers first:

1. Event persistence layer (SSE ingest + durable event log + `since` cursor semantics).
2. Status normalizer:
   - `processing` when session status `busy|retry`
   - `waiting_input` when pending permission/question for that session
   - `idle/completed/failed` derived from latest assistant message + pending queues
3. Auth gateway:
   - bearer auth in front of OpenCode (reverse proxy or wrapper service)
4. Subscription router:
   - server-per-subscription pool
5. Error normalization:
   - handle empty-200 early-failure path defensively (verify message appended or session.error observed)

---

## Bottom Line

If objective is reliable orchestration API + introspection: OpenCode server is already very strong and can remove lots of harness complexity.

If objective is exact native Codex/Claude CLI behavior: keep current native providers; OpenCode should be an additional backend, not a total replacement.

