# Subscription Credentials Research (Merged)

Date: 2026-02-18

Tested environment (combined reports):
- Claude Code: `2.1.45`
- Codex CLI: `0.103.0`
- Host: Linux arm64 (NixOS)

Primary inputs merged:
- `docs/research/subscription-credentials-research.md` (main tester report)
- `/tmp/claude-credentials-research.md`
- `/tmp/codex-credentials-research.md`
- `docs/architecture/wave6-plan.md`
- `src/config.ts`
- `src/session/manager.ts`
- `src/tmux/client.ts`
- `/home/user/repos/ai-quota/src/providers/claude.ts`
- `/home/user/repos/ai-quota/src/providers/codex.ts`

Goal: define reliable multi-subscription credential routing for harness agent creation.

## 1. CLAUDE CODE — credentials, config dirs, env vars, multi-account support, empirical results

### Credential files and structure
- Default config dir: `~/.claude`.
- Primary auth file: `~/.claude/.credentials.json`.
- Claude runtime data is large (`projects/`, `debug/`, etc.), but credential authority is `.credentials.json` unless env overrides.

Observed `.credentials.json` shape (real):

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1771423543090,
    "scopes": ["user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"],
    "subscriptionType": "max",
    "rateLimitTier": "default_claude_max_5x"
  }
}
```

Notes:
- `accessToken`/`refreshToken` are opaque (not JWT).
- `subscriptionType`/`rateLimitTier` may be populated or `null` depending account/state.
- Single active record per dir: `claudeAiOauth`; extra top-level keys are ignored.

### Config directory selection
- `CLAUDE_CONFIG_DIR` is honored for auth and runtime files.
- `strace` confirmed reads from `${CLAUDE_CONFIG_DIR}/.credentials.json`.
- Empty config dir + no auth env => logged out.
- Copying only `.credentials.json` into an alternate dir can authenticate successfully.

### Minimum working credential file (resolved contradiction)
- Main report said "only `.credentials.json` needed".
- Claude-focused report proved `accessToken` alone is not enough.
- Resolved finding: for file-based OAuth auth, minimum working payload is:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "scopes": ["user:inference"]
  }
}
```

Without valid `scopes` including `user:inference`, Claude can report not logged in.

### Env vars and practical precedence
Relevant vars (verified/documented):
- `CLAUDE_CONFIG_DIR`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL`
- `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`

Empirical request-time precedence:
1. `ANTHROPIC_API_KEY`
2. `ANTHROPIC_AUTH_TOKEN`
3. `CLAUDE_CODE_OAUTH_TOKEN`
4. `.credentials.json` in selected config dir

Important behavior:
- `claude auth status --json` can mislead when conflicting env vars are set.
- `auth status` can show logged in based on local file even if token later fails at request-time.

### Subscription/org signals
Best sources in order:
1. OAuth profile API: `https://api.anthropic.com/api/oauth/profile` (plan/org/tier fields)
2. `claude auth status --json` (good signal, not authoritative)
3. `.credentials.json` metadata (`subscriptionType`, `rateLimitTier`)

Observed profile fields included:
- `organization.organization_type` (example: `claude_max`)
- `organization.rate_limit_tier`
- `organization.subscription_status`
- `organization.has_extra_usage_enabled`

Tampering local org metadata (`.claude.json`) can alter status output; does not prove backend routing changed.

### Multi-account support
- Practical model: one account per config dir.
- Multi-account achieved by separate dirs + per-process `CLAUDE_CONFIG_DIR` (or env token override).
- Concurrent isolated runs succeeded (valid dir succeeds, empty dir fails).

### Empirical result matrix
- Empty `CLAUDE_CONFIG_DIR`, no auth env: logged out + prompt fails.
- Copied valid `.credentials.json` in alternate dir: prompt succeeds.
- Valid file + fake `ANTHROPIC_API_KEY`: fails with API key error (proves override).
- Invalid file + valid `CLAUDE_CODE_OAUTH_TOKEN`: succeeds (proves env override).

## 2. CODEX CLI — credentials, config dirs, env vars, JWT details, multi-account support, empirical results

### Credential files and structure
- Default config dir: `~/.codex`.
- Override: `CODEX_HOME` (confirmed via docs + `strace` + runtime).
- Primary auth file: `${CODEX_HOME}/auth.json`.
- Other runtime files: `${CODEX_HOME}/sessions/...`, `log/codex-tui.log`, etc.

Observed auth shapes:

ChatGPT token mode:
```json
{
  "OPENAI_API_KEY": null,
  "last_refresh": "2026-...",
  "tokens": {
    "id_token": "JWT",
    "access_token": "JWT",
    "refresh_token": "rt_...",
    "account_id": "uuid"
  }
}
```

API key mode:
```json
{
  "OPENAI_API_KEY": "sk-...",
  "auth_mode": "apikey"
}
```

Also valid in tests:
```json
{"OPENAI_API_KEY":"sk-..."}
```

### JWT details (`id_token` and `access_token`)
Decoded claims included:
- `email`
- `https://api.openai.com/auth.chatgpt_plan_type` (example observed: `plus`)
- `https://api.openai.com/auth.chatgpt_account_id`
- `https://api.openai.com/auth.chatgpt_user_id`
- `https://api.openai.com/auth.chatgpt_subscription_active_until`
- `https://api.openai.com/auth.organizations[]` with `id`, `title`, `role`, `is_default`

`id_token` is best local source for plan/org/workspace metadata.

### Auth mode behavior and precedence (critical)
Resolved cross-report findings:
- ChatGPT token auth needs complete token bundle + `last_refresh`.
- Missing required token fields or missing `last_refresh` can fail with token-data errors.
- `OPENAI_API_KEY` persisted in `auth.json` enables API key login mode.
- `CODEX_API_KEY` env is a runtime override and can force API-key request auth even when OAuth tokens exist.
- `OPENAI_API_KEY` env alone did not reliably authenticate `codex exec` in tested setup.

`auth_mode` behavior from main tester matrix:
- `auth_mode: "chatgpt"` can force token path even if `OPENAI_API_KEY` exists.
- `auth_mode: "apikey"` forces key path.

### Workspace guardrail (`forced_chatgpt_workspace_id`)
- If configured and mismatch with token `account_id`, Codex logs out and may delete `auth.json` in that `CODEX_HOME`.
- If it matches, run continues.
- This is the strongest built-in guard for "must run under this workspace".

### Config and store behavior
- `config.toml` is not required for auth itself.
- Credential store mode `file` works consistently.
- `keyring` can fail on hosts without Secret Service.
- `ephemeral` login does not persist `auth.json`.

### Multi-account support
- One effective account/mode per `CODEX_HOME`.
- Multiple accounts supported by multiple homes.
- Copying `auth.json` into another home works immediately.
- `/tmp` homes warn about helper binaries; avoid `/tmp` for production homes.

### Empirical result matrix
- Empty home: not logged in; `codex exec` missing bearer auth.
- `config.toml` only: still not logged in.
- Valid token `auth.json`: login + exec success.
- Token file missing refresh/required fields: failure.
- Key-only `auth.json`: login shows API key mode; exec uses key.
- Valid tokens + `CODEX_API_KEY=dummy`: requests use dummy key (override confirmed).

### Plan handling (Plus/Pro/Team/etc)
- Local account observed `chatgpt_plan_type: plus` in JWT.
- Docs + binary strings indicate support for Plus/Pro/Team/Edu/Enterprise.
- Authoritative runtime mapping should use JWT claims, not UI labels.

## 3. MULTI-SUBSCRIPTION ARCHITECTURE — harness API exposure, config schema, API design

### Current harness state (relevant constraints)
- `src/config.ts`: no `subscriptions` schema; only provider-level `env`.
- `src/api/agents.ts`: create-agent body has `provider`, `task`, optional `model`; no subscription selector.
- `src/session/manager.ts`:
  - `createAgent(project, provider, task, model?)` has no subscription arg.
  - Codex runtime dir auto-created per agent under `logDir/codex/<agentId>`, symlinking default `~/.codex/auth.json` and `config.toml`.
  - Claude has no equivalent credential dir materialization.
- `src/tmux/client.ts`: env injected via `tmux set-environment` at session scope before `new-window`.

### Required product behavior
- API caller chooses subscription per agent creation.
- Harness validates subscription exists and matches provider.
- Harness runs agent with isolated, deterministic credential context.
- Default behavior unchanged when subscription omitted.

### Proposed config schema
Add top-level `subscriptions` map with provider-specific entries.

```json
{
  "subscriptions": {
    "claude-max-user": {
      "provider": "claude-code",
      "mode": "oauth",
      "sourceDir": "/home/user/.claude-user",
      "expected": {
        "subscriptionType": "max"
      }
    },
    "codex-plus-user": {
      "provider": "codex",
      "mode": "chatgpt",
      "sourceDir": "/home/user/.codex-user",
      "workspaceId": "c5191700-5593-423b-88dc-204344f3af07",
      "enforceWorkspace": true
    },
    "codex-api-ci": {
      "provider": "codex",
      "mode": "apikey",
      "sourceDir": "/home/user/.codex-ci"
    }
  }
}
```

Validation rules:
- `sourceDir` must exist/readable.
- Claude mode requires parseable `.credentials.json` with `accessToken` + valid `scopes`.
- Codex chatgpt mode requires parseable token bundle + `last_refresh`.
- Codex apikey mode requires `OPENAI_API_KEY` in `auth.json` (or explicit env source model if added).

### Proposed API changes
1. Extend `POST /api/v1/projects/:name/agents` body:

```json
{
  "provider": "codex",
  "task": "Implement X",
  "model": "gpt-5.3-codex",
  "subscription": "codex-plus-user"
}
```

2. Add `GET /api/v1/subscriptions`:
- Returns sanitized list with:
  - `id`, `provider`, `mode`
  - validity state (`ok`/`invalid` + reason)
  - inferred metadata (`plan`, `workspaceId`, `email`, token expiry)
- Never returns raw tokens.

### Spawn-time resolution algorithm
1. Parse request; if `subscription` absent, use current legacy provider env behavior.
2. Resolve subscription record; enforce provider match.
3. Build per-agent runtime dir under `logDir/runtime/<provider>/<agentId>` (0700).
4. Materialize minimal credential files:
- Claude: `.credentials.json`
- Codex: `auth.json` (+ optional `config.toml`)
5. Set per-agent env:
- Claude: `CLAUDE_CONFIG_DIR=<runtimeDir>`
- Codex: `CODEX_HOME=<runtimeDir>`
6. Apply provider guardrails:
- Codex chatgpt mode: set `forced_chatgpt_workspace_id` when `enforceWorkspace=true`.
- Scrub conflicting env vars (see below).
7. Spawn process with env scoped to that window/process only.

### Env scrubbing policy
When subscription selected, remove inherited vars that can silently switch auth path.

Claude scrub list:
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `CLAUDE_PROFILE_*` unless explicitly required for that subscription

Codex scrub list:
- `CODEX_API_KEY` (unless subscription mode intentionally env-key)
- `OPENAI_API_KEY` when running ChatGPT-token mode

### tmux isolation correction
Current `tmux set-environment` is session-global, so concurrent agent creates can race.
Needed change:
- Stop mutating session-global env for per-agent secrets.
- Prefer command-prefixed env for `new-window` command (or proven per-window env mechanism).

## 4. SHARED UTILS — common code to extract between ai-quota and agent-harness

### Why extraction is needed
Both repos parse same credential artifacts but current schemas diverge and under-model real files.

Known gaps in `ai-quota`:
- `claude.ts`: schema omits `scopes`.
- `codex.ts`: schema omits `OPENAI_API_KEY`, `access_token`, `refresh_token`, `auth_mode`, and mode logic.

### Suggested shared module boundaries
1. `credentials/claude.ts`
- Schema for `.credentials.json` including `scopes`.
- Validation helpers: minimum-valid auth payload.
- Metadata extractors: subscription/tier hints.

2. `credentials/codex.ts`
- Union schema for ChatGPT-token mode vs API-key mode.
- Validation helpers for required token fields + `last_refresh`.
- Workspace/account extractor.

3. `credentials/jwt.ts`
- Safe JWT payload decode helper (no signature verification).
- Claim mappers for plan/org/email/expiry.

4. `credentials/paths.ts`
- Default + env-overridden config dir resolvers (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).

5. `credentials/sanitize.ts`
- Env scrub helpers for provider-specific override lists.

### Test fixtures
- Add redacted real-world fixtures (one per mode/provider).
- Use same fixtures in both repos to prevent schema drift.

## 5. IMPLEMENTATION PLAN — ordered steps to add subscription support to harness

1. **Add schema types**
- Extend `src/config.ts` with `subscriptions` Zod schema + provider-specific unions.
- Keep `providers` unchanged for backward compatibility.

2. **Add credential validation layer**
- New module to parse/validate Claude/Codex subscription source dirs at startup.
- Cache sanitized metadata for API listing.

3. **Add subscription API**
- Implement `GET /api/v1/subscriptions`.
- Extend create-agent request schema in `src/api/agents.ts` with optional `subscription`.

4. **Thread subscription through manager**
- Update `manager.createAgent(...)` signature to accept optional subscription id.
- Resolve subscription to runtime materialization plan.

5. **Materialize runtime dirs**
- Build `logDir/runtime/...` per agent with 0700 perms.
- Copy/symlink minimal required auth files from subscription source.
- Write provider env (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`) from resolved runtime path.

6. **Fix env isolation in tmux client**
- Replace session-global `set-environment` path for secret env with per-window/per-command env application.
- Ensure concurrent agent starts cannot leak/swap env.

7. **Apply provider guardrails**
- Codex: apply `forced_chatgpt_workspace_id` when configured.
- Scrub conflicting inherited env vars before spawn.

8. **Testing**
- Unit tests: schemas, validators, env scrub lists.
- Integration tests:
  - Two codex subscriptions in same project/session stay isolated.
  - Two claude subscriptions stay isolated.
  - Env contamination prevention (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`).
  - Codex workspace mismatch failure path.

9. **Operational rollout**
- Add docs with subscription setup examples.
- Add startup diagnostics for invalid subscriptions.
- Keep legacy no-subscription path default to avoid breaking current callers.

## 6. OPEN QUESTIONS — unresolved items needing investigation

1. Codex `auth_mode` + mixed token/key fields
- Main matrix indicates explicit `auth_mode` can force path; re-verify against current/upcoming Codex CLI versions.

2. Token refresh strategy under per-agent runtime dirs
- If files are copied (not shared), refresh writes may not flow back to canonical source dirs.
- Decide copy vs symlink model intentionally.

3. Claude minimum scope set stability
- Current minimum works with `user:inference`; confirm if future Claude versions require additional scopes.

4. Source-of-truth for plan labels
- Claude local metadata can be stale/spoofable; Codex claim names may evolve.
- Define canonical validation source for UI/API display.

5. Keyring-host compatibility
- Codex `keyring` mode fails on some NixOS hosts; define supported credential-store mode for production hosts.

6. Runtime secret lifecycle
- Define retention/cleanup policy for per-agent runtime dirs containing auth files.
- Confirm secure deletion requirements (if any) for your threat model.

---

## End-state summary
- Multi-subscription support is feasible now with per-agent config-home isolation.
- Critical correctness point: credential source selection is mostly env/home-path driven, and a few env vars can silently override selected profile if not scrubbed.
- Highest-risk implementation bug to avoid: session-scoped tmux env mutation leaking credentials across concurrent agents.
