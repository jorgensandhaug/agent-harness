# Wave 4 Review (Spec vs Reality)

Spec: `docs/architecture/wave2-plan.md`
Code reviewed: all files under `src/`

## 1. CORRECTNESS

### Missing from spec-defined module/interface surface
- Missing provider modules: `src/providers/codex.ts`, `src/providers/pi.ts`, `src/providers/opencode.ts`.
- Missing test files listed in plan: `tmux/client.test.ts`, provider tests, store/manager/poller/bus tests.
- Provider registry only registers `claude-code`; spec defines multi-provider harness (`claude-code`, `codex`, `pi`, `opencode`).
- Config defaults only include `claude-code`; spec default includes all 4 providers.

### API behavior deviations
- `GET /api/v1/projects/:name/agents/:id` returns truncated `lastOutput` (`slice(-2000)`), not full recent output as implied by spec.
- Agent event route implemented as `/api/v1/projects/:name/agents/:agentId/events`; spec path uses `:id`.
- `UNKNOWN_PROVIDER`/`PROVIDER_DISABLED` mapped to `400 INVALID_REQUEST`; plan defines error-code table but no explicit provider code. This is workable but inconsistent with strict machine-code granularity elsewhere.
- `TMUX_UNAVAILABLE` (503) is defined in plan but never emitted by API routes.

### Lifecycle/event correctness gaps
- `manager.deleteProject()` ignores tmux kill failure and still returns success.
- `manager.abortAgent()` ignores failure from first `sendKeys(Escape)` call.
- `manager.deleteAgent()` ignores failures from graceful exit send and window kill; still emits `agent_exited` + returns success.
- Initial task send in `createAgent()` is delayed in `setTimeout` and detached from request lifecycle; API returns 201 before proving delivery.

### Polling/diff correctness risks
- `poller/differ.ts` algorithm is heuristic and fragile for repeated lines/scrollback churn; comments in file itself indicate unresolved logic uncertainty.
- Poller emits `tool_result` with empty output because provider tool-end parsing does not capture output payload.

## 2. CODE CLEANLINESS

- Structure mostly matches spec boundaries (`api`, `events`, `poller`, `session`, `tmux`, `providers`).
- Major cleanliness gap: architecture claims multi-provider, implementation is effectively single-provider.
- `poller/differ.ts` contains contradictory exploratory comments ("Wait — rethinking"); reads like scratchpad, not production logic.
- Error mapping logic duplicated in `api/projects.ts` and `api/agents.ts` (could be centralized).
- `tmux/client.ts` is large, many responsibilities in one file (exec, parsing, temp-file IO, list parsing, env management).

## 3. ERROR HANDLING

- Multiple swallowed/ignored error paths:
  - `src/index.ts`: shutdown loop catches and discards delete-agent failures.
  - `src/tmux/client.ts`: temp-file cleanup swallows all errors.
  - `src/session/manager.ts`: several tmux calls intentionally ignored on delete/abort paths.
- Startup tmux check only hard-fails for `TMUX_NOT_INSTALLED`; other tmux command failures do not fail startup.
- SSE handlers set `closed=true` on write failure but do not always unsubscribe immediately; cleanup relies on abort loop.
- No retries/backoff for transient tmux failures in polling.

## 4. TYPE SAFETY

- No `any`, `ts-ignore`, or `ts-expect-error` found.
- Frequent `as` casts:
  - Branding casts in `src/types.ts` (`as AgentId`, `as ProjectName`, `as EventId`).
  - Route `since` query cast to `EventId` in `src/api/events.ts` without validation.
  - Poller casts `agent.id as AgentId` repeatedly.
- Error objects are often widened to `{ code: string; ... }` in API mappers, losing discriminated-union exhaustiveness.
- Event ID format assumed by `eventIdCounter`; invalid IDs degrade to counter `0` silently.

## 5. MISSING PIECES

### In plan, not implemented
- Providers: Codex, Pi, OpenCode.
- Tests across all modules listed in plan.
- `TmuxClient` explicit interface type (functions exist, interface contract not defined/exported as in plan).
- Potential reclaim/orphan-session startup behavior from flagged unknowns (not required now but noted in plan narrative).
- Full provider defaults in config.
- `TMUX_UNAVAILABLE` API response path.

### Implemented, not in plan (or stricter than plan)
- Global CORS enabled on all routes.
- SSE heartbeat event every 15s.
- Output truncation in `GET agent` endpoint.
- Hardcoded health `version = "0.1.0"`.

## Bottom line
- Core skeleton exists and follows the intended architecture.
- Current implementation is MVP-incomplete relative to plan: multi-provider scope and test coverage are the largest gaps.
- Reliability risk is concentrated in error swallowing and fragile pane-diff logic.
