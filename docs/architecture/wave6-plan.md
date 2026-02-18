# Wave 6: Productionization Plan

**Date**: 2026-02-18
**Input**: Waves 1-5 complete (69 tests, all providers working, inspector UI, messages API)
**Scope**: Binary packaging, CLI subcommands, webhook support, NixOS module, auth

---

## 6A. CLI Entrypoint + Binary Packaging

### Current state
- `src/index.ts` just starts the server directly
- No CLI argument parsing
- Run via `bun run src/index.ts`

### Target
- `src/cli.ts` — CLI entrypoint with subcommands
- `bun build --compile src/cli.ts --outfile agent-harness` → single binary
- Subcommands:
  - `agent-harness serve` — start daemon (current behavior)
  - `agent-harness status` — check if daemon is running, print summary
  - `agent-harness version` — print version
- Binary works standalone (no bun required at runtime)

### Implementation
1. Create `src/cli.ts` with minimal arg parsing (no library — just `process.argv`)
2. Move current `main()` from `index.ts` into `serve` command
3. Add `status` command: hits `GET /api/v1/health`, prints formatted output
4. Add `version` command: prints package version
5. Update `package.json` scripts: `"build": "bun build --compile src/cli.ts --outfile agent-harness"`
6. Add `"bin"` field to package.json
7. Test: build binary, run `./agent-harness serve`, verify it works
8. Test: `./agent-harness status` against running instance

---

## 6B. Bearer Token Auth

### Design
- Config field: `auth.token` (optional string)
- If set, all API requests require `Authorization: Bearer <token>`
- Health endpoint exempt (so monitoring works)
- Token comes from config file or `AH_AUTH_TOKEN` env var

### Implementation
1. Add `auth?: { token?: string }` to config schema
2. Add Hono middleware that checks Bearer token
3. Exempt `/api/v1/health` from auth
4. Tests: requests without token → 401, with token → pass through

---

## 6C. Webhook Support

### Design
When an agent's status changes (especially to `idle` after being `processing`), POST a webhook notification.

Config:
```json
{
  "webhook": {
    "url": "http://100.85.245.12:7071/harness-webhook",
    "token": "secret",
    "events": ["agent_completed", "agent_error", "agent_exited"]
  }
}
```

Webhook payload:
```json
{
  "event": "agent_completed",
  "project": "lumen-fix-123",
  "agentId": "a3f2b1c0",
  "provider": "claude-code",
  "status": "idle",
  "lastMessage": "I've fixed the auth bug...",
  "timestamp": "2026-02-18T10:00:00Z"
}
```

### Implementation
1. Add `webhook` to config schema (Zod)
2. Create `src/webhook/client.ts` — simple fetch POST with bearer token, retry once on failure
3. Subscribe to event bus for status_changed events
4. When status transitions to idle/exited/error from processing → fire webhook
5. Include `lastMessage` from messages API in payload (so receiver has context)
6. Tests: mock webhook endpoint, verify payloads

---

## 6D. Webhook Receiver (same repo, separate binary)

Lives in the agent-harness repo as a separate entrypoint. Compiles to its own binary via `bun build --compile`. NixOS module runs both binaries as separate systemd units.

**Purpose:** Receives webhook POSTs from the harness and does two things:
1. Posts to a Discord channel (audit trail)
2. Sends a system event to OpenClaw (bumps the main session)

**Implementation:**
- `src/webhook-receiver.ts` — separate entrypoint in the same repo
- Hono server on port 7071
- Validates bearer token
- On POST: extracts event info, calls `openclaw system event` + Discord webhook
- NixOS systemd unit

---

## Order
1. 6A (CLI + binary) — no dependencies
2. 6B (auth) — no dependencies, can parallel with 6A
3. 6C (webhook client in harness) — after 6A/6B merged
4. 6D (webhook receiver on jorgebot) — can parallel with 6C
