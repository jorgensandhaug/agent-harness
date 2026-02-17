# Wave 5 Test Plan

Scope: full test strategy for `src/**` using `bun test`, including real tmux + real agents.

## Goals
- Verify core logic deterministically with unit tests.
- Verify real I/O behavior with tmux + HTTP integration tests.
- Run real agent smoke tests for `claude-code`, `codex`, `pi`, `opencode` with strict token/cost controls.
- Keep default PR test run fast + free; gate paid tests behind explicit env flags.

## Test Execution Tiers
- Tier 1 (`bun test` default): unit tests + non-agent integration tests. Target <30s. Cost $0.
- Tier 2 (`LIVE_AGENT_TESTS=1 bun test test/integration/agents`): real-agent smoke tests. Target <3m. Cost cap <$0.10.
- Tier 3 (`FULL_E2E=1 bun test`): optional extended matrix (multiple prompts/status edge cases), scheduled only.

## Shared Test Setup
- Use unique tmux prefix per test run: `ah-test-${Date.now()}`.
- Create isolated temp cwd per integration test (`mkdtemp`).
- Always cleanup in `afterEach`/`afterAll`:
  - kill created agents
  - kill created tmux sessions
  - stop Bun server
- Deterministic polling for tests: `pollIntervalMs=200`, `captureLines=200`.
- Add helper waiters:
  - `waitForStatus(project, agentId, status, timeoutMs)`
  - `waitForEvent(type, filter, timeoutMs)`

## Unit Tests

| Name | Verifies | Setup Needed | Expected Behavior | Real Agent or Fixtures |
|---|---|---|---|---|
| `providers/claude.parseStatus.idle-processing-error-exited` | Claude status parsing across known markers/ANSI | string fixtures (`test/fixtures/providers/claude/*.txt`) | returns correct `AgentStatus` for each fixture | Fixtures |
| `providers/codex.parseStatus.smoke` | Codex status regex paths (`idle`, `processing`, `error`, `waiting_input`) | synthetic + captured fixture text | correct status per case | Fixtures |
| `providers/pi.parseStatus.smoke` | Pi status regex paths | synthetic + captured fixture text | correct status per case | Fixtures |
| `providers/opencode.parseStatus.smoke` | OpenCode status regex paths | synthetic + captured fixture text | correct status per case | Fixtures |
| `providers/*.parseOutputDiff.events` | provider diff-to-events mapping (text/error/permission/unknown/tool where applicable) | fixture snippets per provider | emitted `ProviderEvent[]` matches expected kinds/order | Fixtures |
| `poller/differ.basic-overlap` | `diffCaptures` for normal append-only output | before/after strings | returns only newly appended lines | Fixtures |
| `poller/differ.repeated-lines-scrollback` | `diffCaptures` under repeated lines/scroll movement | crafted edge-case strings | returns stable diff; no dropped/duplicated tail lines | Fixtures |
| `events/bus.emit-subscribe-filter` | filter logic for project/agent/type | in-memory bus | subscribers only receive matching events | Fixtures |
| `events/bus.since-replay` | replay after event id | in-memory bus with multiple events | returns strictly newer matching events | Fixtures |
| `config/load.defaults` | default config when file missing | temp dir no `harness.json` | defaults include all providers + expected scalar defaults | Fixtures |
| `config/load.valid-file` | valid user config merges/parses | temp `harness.json` | parsed config equals input + defaults where omitted | Fixtures |
| `config/load.invalid-file` | strict validation + useful error | invalid `harness.json` | throws with field-specific message | Fixtures |
| `tmux/client.command-shape` | tmux args built correctly for each exported function | mock `Bun.spawn` capture args | expected argv per call (`new-session`, `new-window`, `capture-pane`, etc.) | Fixtures |
| `api/errors.mapManagerError` | manager error to HTTP mapping | pure function inputs | status/body mapping exact and stable | Fixtures |

## Integration Tests (Real I/O)

| Name | Verifies | Setup Needed | Expected Behavior | Real Agent or Fixtures |
|---|---|---|---|---|
| `tmux/client.session-lifecycle` | real tmux create/list/kill session | local tmux installed | create succeeds, listed with prefix, kill removes it | Real I/O (tmux) |
| `tmux/client.window-input-capture` | real window creation + `sendInput` + `capturePane` | session + shell command window (`cat` or `bash`) | pasted text appears in pane capture | Real I/O (tmux) |
| `tmux/client.sendKeys-abort` | control key send path | session/window running blocking command (`sleep`) | process interrupted after `C-c` | Real I/O (tmux) |
| `http/health` | server boots + `/api/v1/health` contract | start app via `createApp` on random port | returns uptime/projects/agents/tmuxAvailable/version | Real I/O (HTTP + tmux probe) |
| `http/projects.crud` | project create/list/get/delete endpoints | running server + temp cwd | status codes and payloads match API contract | Real I/O (HTTP + tmux) |
| `http/agents.crud-input-output-abort` | agent endpoints end-to-end | running server, provider=`claude-code` with cheap prompt | create returns 201, input 202, output endpoint returns capture, abort/delete work | Real I/O (HTTP + tmux + 1 real agent) |
| `http/events.sse.project-stream` | project SSE stream + replay by `since` | running server + active agent | receives ordered events and heartbeat, reconnect replay works | Real I/O (HTTP SSE + tmux) |
| `http/events.sse.agent-stream` | per-agent SSE filtering | running server + 2 agents in project | stream receives only selected agent events | Real I/O (HTTP SSE + tmux) |

## Live Agent Smoke Tests (Real Processes)

Common contract for each provider smoke test:
- Create project.
- Create one agent with provider + cheapest model.
- Send trivial prompt: `Reply with exactly: 4`.
- Assert within timeout:
  - status transitions include `starting` and at least one of `processing`/`idle`.
  - at least one `output` event emitted.
  - no harness crash; delete agent + project succeeds.

| Name | Verifies | Setup Needed | Expected Behavior | Real Agent or Fixtures |
|---|---|---|---|---|
| `agents/live-claude.smoke` | Claude provider works against real CLI | `LIVE_AGENT_TESTS=1`, valid Claude auth, cheap model configured | contract above passes within 60s | Real agent |
| `agents/live-codex.smoke` | Codex provider + regex status heuristics | `LIVE_AGENT_TESTS=1`, valid Codex auth, cheap model | contract above passes within 60s | Real agent |
| `agents/live-pi.smoke` | Pi provider smoke | `LIVE_AGENT_TESTS=1`, valid Pi auth, cheap model | contract above passes within 60s | Real agent |
| `agents/live-opencode.smoke` | OpenCode provider smoke | `LIVE_AGENT_TESTS=1`, valid OpenCode auth, cheap model | contract above passes within 60s | Real agent |

## Token-Efficient Strategy (Cost Guardrails)

### Prompt policy
- Single short prompt only: `Reply with exactly: 4`.
- No follow-ups unless test fails and retry is enabled.
- Max 1 live test run per provider per CI execution.

### Model policy
- Force cheapest/fastest model per provider via test config override:
  - `claude-code`: haiku-class model.
  - `codex`: mini/nano-class model.
  - `pi`: smallest available model.
  - `opencode`: smallest available model.
- Model names supplied by env so they can be changed without code edits:
  - `TEST_MODEL_CLAUDE`, `TEST_MODEL_CODEX`, `TEST_MODEL_PI`, `TEST_MODEL_OPENCODE`.

### Runtime limits
- Per-provider timeout: 60s hard cap.
- Fail fast if no transition from `starting` within 20s.
- Abort and cleanup immediately on timeout.

### Spend controls
- `LIVE_AGENT_TESTS` default `0`.
- `MAX_LIVE_PROVIDER_TESTS` default `4`, optional lower value for local runs.
- Optional dry run mode (`LIVE_AGENT_TESTS=plan`) logs intended commands without spawning agents.
- CI schedule: run Tier 2 nightly, not every PR.

### Fixture-first approach
- Capture one real pane transcript per provider and store in `test/fixtures/providers/<provider>/`.
- Use fixture-based parser tests for broad coverage (status/output variants) with zero token cost.
- Keep live tests as smoke-only to validate CLI integration and regex assumptions.

Estimated spend for Tier 2 (4 providers, one tiny prompt each): typically a few cents; hard target <$0.10.

## Proposed Test Layout

```text
test/
  unit/
    providers/
    poller/
    events/
    config/
    tmux/
    api/
  integration/
    tmux/
    http/
    agents/
  fixtures/
    providers/
      claude/
      codex/
      pi/
      opencode/
  helpers/
    tmux.ts
    server.ts
    wait.ts
```

## Exit Criteria for Wave 5
- Unit tests cover all provider parsers + event bus + config + diff logic.
- Integration tests cover tmux client lifecycle and all HTTP endpoints.
- Live smoke tests exist and pass for all 4 providers when `LIVE_AGENT_TESTS=1`.
- Default test run remains free and fast.
