# RSS Growth / Quiesced Polling Implementation Plan

## Scope

This document covers the `agent-harness` RSS growth / OOM issue seen on vm1 and proposes a staged, conservative fix. It does **not** implement code. The goal is to stop endless polling of already-completed agents without regressing terminal semantics:

- preserve final `idle` / `error` delivery
- preserve the final assistant message used in callback/webhook payloads
- avoid duplicate callback/webhook delivery across ordinary retries and daemon restarts
- allow later `sendInput` to reactivate a quiesced agent safely

The live-service context matters:

- vm1 currently runs an older Nix-provided Bun `1.1.31` under systemd
- vm1 also has a user-installed Bun `1.3.10`
- short reproductions reportedly show materially lower RSS growth on Bun `1.3.10`
- the poller currently runs every `1000ms`
- the poller currently polls **all non-`exited` agents**, including many long-idle completed Codex agents

## Root Cause

### What the code is doing today

The poller in [`src/poller/poller.ts`](/home/jorge/repos/agent-harness/src/poller/poller.ts) runs every second and, for every agent whose public status is not `exited`, does all of the following:

1. `tmux` metadata reads (`pane_dead`, `pane_current_command`)
2. full pane capture via `tmux.capturePane(...)`
3. full-string diffing against the previous capture via [`src/poller/differ.ts`](/home/jorge/repos/agent-harness/src/poller/differ.ts)
4. provider-specific status parsing
5. provider-internals reads for status

For Codex specifically, [`src/poller/codex-internals.ts`](/home/jorge/repos/agent-harness/src/poller/codex-internals.ts) still rereads large files on every poll:

- `history.jsonl`
- directory listings under `sessions/YYYY/MM/DD`
- the full current session file via `Bun.file(file).text()`

The same general pattern exists for other providers:

- Claude: [`src/poller/claude-internals.ts`](/home/jorge/repos/agent-harness/src/poller/claude-internals.ts)
- Pi: [`src/poller/pi-internals.ts`](/home/jorge/repos/agent-harness/src/poller/pi-internals.ts)
- OpenCode: [`src/poller/opencode-internals.ts`](/home/jorge/repos/agent-harness/src/poller/opencode-internals.ts)

Completed idle agents therefore keep generating repeated large allocations forever, even when nothing user-visible can still happen.

### Why this looks like an RSS ratchet, not an obvious app-level leak

The main in-process data structures are bounded or one-per-agent:

- event bus history is bounded by `maxEventHistory` in [`src/events/bus.ts`](/home/jorge/repos/agent-harness/src/events/bus.ts)
- debug-tracker history is bounded in [`src/debug/tracker.ts`](/home/jorge/repos/agent-harness/src/debug/tracker.ts)
- the store keeps one `lastCapturedOutput` string per agent in [`src/session/store.ts`](/home/jorge/repos/agent-harness/src/session/store.ts)
- poller runtime state is one cursor bundle per polled agent in [`src/poller/poller.ts`](/home/jorge/repos/agent-harness/src/poller/poller.ts)

There is no obvious unbounded JavaScript collection that grows once per poll forever.

What **is** happening is repeated allocation of large transient strings and arrays:

- full tmux captures
- `split("\n")` arrays in diffing
- full session-file reads
- repeated JSON parsing of growing session logs

That pattern is enough to drive RSS upward if the Bun/JSC allocator retains pages instead of promptly returning them to the OS. The report that Bun `1.3.10` shows much lower RSS growth strongly supports that interpretation.

### Conservative conclusion

The most likely diagnosis is:

- **primary cause**: application-level repeated polling/allocation against already-quiescent agents
- **amplifier**: Bun `1.1.31` allocator/runtime behavior causing RSS retention or ratcheting under that allocation pattern
- **not proven**: a true unbounded app-level object leak in `agent-harness` itself

That does **not** rule out a runtime leak in Bun `1.1.31`, but the service should still be fixed because the current polling model creates unnecessary allocation churn even on newer Bun.

## Proposed Polling Lifecycle

### Public agent status stays unchanged

Do **not** add `quiesced` to the public `AgentStatus` union in [`src/providers/types.ts`](/home/jorge/repos/agent-harness/src/providers/types.ts).

Keep public status exactly as it is today:

- `starting`
- `processing`
- `waiting_input`
- `idle`
- `error`
- `exited`

Reason:

- avoids unnecessary API/CLI churn
- preserves current client semantics
- keeps CLI/API parity burden out of this fix

### Add a separate internal polling lifecycle

Add a new internal field on `Agent` in [`src/session/types.ts`](/home/jorge/repos/agent-harness/src/session/types.ts):

- `pollState: "active" | "finalizing" | "quiesced"`

Add a small terminal-finalization record on `Agent` as internal metadata, for example:

- `terminalStatus: "idle" | "error" | "exited" | null`
- `terminalObservedAt: string | null`
- `terminalQuietSince: string | null`
- `finalizedAt: string | null`
- `finalMessage: string | null`
- `finalMessageSource: string | null`
- `deliveryState: "pending" | "sent" | "not_applicable"`
- `deliveryInFlight: boolean`
- `deliveryId: string | null`
- `deliverySentAt: string | null`

Persist the minimum needed subset to disk in a new state module, rather than only in memory.

### Exact state machine

#### 1. Active

Definition:

- default for new agents
- default for any agent after successful `sendInput`
- poller runs at full frequency

Transitions from `active`:

- non-terminal statuses (`starting`, `processing`, `waiting_input`) stay `active`
- first transition to `idle` or `error` moves to `finalizing`
- first transition to `exited` moves to `finalizing`

#### 2. Finalizing

Definition:

- still polled every interval
- terminal snapshot is being stabilized before quiescing

On entry:

- record `terminalStatus`
- record `terminalObservedAt`
- set `terminalQuietSince = now` only if current poll had no output diff; otherwise leave null until the first quiet poll
- create deterministic `deliveryId`
- set `deliveryState = pending` if a callback/webhook target exists, else `not_applicable`
- set `deliveryInFlight = false`

While in `finalizing`:

- if new diff appears, update `terminalQuietSince = null` and keep polling
- if status returns to a non-terminal state, clear terminal metadata and go back to `active`
- if a follow-up `sendInput` succeeds, clear terminal metadata and go back to `active`

Quiesce condition for `idle` / `error`:

- status is still the same terminal status
- no pane diff for at least `2000ms`
- final assistant-message snapshot is identical on **two consecutive** finalization reads
- hard stop at `10000ms`: if still stable enough to stop polling but no assistant message is available, finalize with `finalMessage = null`

Quiesce condition for direct `exited`:

- no need to wait for pane quieting because the pane is already dead
- do two bounded message reads over `1000ms` total to catch the already-written final assistant message if provider internals are present
- then finalize as `exited` even if `finalMessage` is null

#### 3. Quiesced

Definition:

- poller no longer captures pane output or rereads provider internals for this agent
- public status remains whatever terminal status was finalized (`idle`, `error`, or `exited`)

Transitions from `quiesced`:

- successful `sendInput` -> `active`
- delete agent/project -> removed

Important deliberate behavior:

- once an already-completed `idle` / `error` agent is quiesced, the daemon no longer passively watches for a later pane death
- this is acceptable for this fix because the required user-visible terminal semantics are the completion/error semantics, not endless post-completion exit observation

## Terminal Finalization and Callback Delivery

### Problem with the current design

Today terminal delivery is keyed directly off `status_changed` in [`src/webhook/client.ts`](/home/jorge/repos/agent-harness/src/webhook/client.ts), and the last assistant message is read lazily at delivery time from [`src/session/messages.ts`](/home/jorge/repos/agent-harness/src/session/messages.ts).

That creates a race:

- poller may see terminal status before the provider internals file is fully settled
- webhook delivery may happen before the final assistant message is readable
- if polling stops immediately on `idle`, the final message may never be captured reliably

### Proposed design

Move terminal delivery from raw `status_changed` to a new explicit **terminal-finalized** signal.

Recommended shape:

- keep emitting `status_changed` immediately for UI/debug visibility
- add a new event type, for example `agent_terminal_finalized`
- emit it only after the finalization grace/stability rules above succeed

The event payload should include:

- `project`
- `agentId`
- `provider`
- `status`
- `finalizedAt`
- `terminalObservedAt`
- `lastMessage`
- `messageSource`
- `deliveryId`

The webhook client should:

- subscribe to `agent_terminal_finalized`, not raw terminal `status_changed`
- send callback/webhook from the finalized snapshot, not by rereading live provider files
- mark delivery success in durable state
- set `deliveryInFlight = true` before any POST and clear it afterward
- skip any duplicate concurrent attempt when `deliveryInFlight = true`
- retry once immediately on failure, then rely on the existing safety-net interval for later retries

### Delivery durability and duplicate prevention

Add a new persisted state module, separate from callback routing state, for example:

- [`src/session/terminal-state.ts`](/home/jorge/repos/agent-harness/src/session/terminal-state.ts) (new)

Persist at least:

- `pollState`
- `terminalStatus`
- `terminalObservedAt`
- `finalizedAt`
- `finalMessage`
- `deliveryState`
- `deliveryInFlight`
- `deliveryId`
- `deliverySentAt`

Restart behavior:

- `quiesced` + `deliveryState = sent`: do not redeliver; do not repoll
- `quiesced` + `deliveryState = pending`: do not repoll; delivery retries from the persisted snapshot
- `finalizing`: resume polling/finalization
- `active`: normal polling

That removes the current in-memory-only duplicate-suppression weakness in [`src/webhook/client.ts`](/home/jorge/repos/agent-harness/src/webhook/client.ts).

Retry policy should stay conservative:

- agent/project callbacks: keep the current auto-retry behavior
- global fallback webhook only: keep auto-retry gated by explicit `safetyNet.enabled`, matching current behavior

Persisting `pending` state is still useful for observability even when automatic global-fallback replay remains disabled.

### Important exact-once caveat

True exactly-once delivery to an arbitrary external HTTP endpoint is impossible if the process crashes after the receiver has accepted the POST but before the daemon durably records success.

Therefore:

- the daemon can guarantee **no duplicate sends across normal retries/restarts once success is durably recorded**
- for crash-proof external exactly-once, the payload should also carry a stable `deliveryId`, and cooperating receivers should dedupe on that key

The built-in receiver in [`src/webhook-receiver.ts`](/home/jorge/repos/agent-harness/src/webhook-receiver.ts) can be extended later to accept an optional `deliveryId`. That is recommended but not required for the first safe quiescing rollout.

## sendInput Reactivation Rules

`sendInput` in [`src/session/manager.ts`](/home/jorge/repos/agent-harness/src/session/manager.ts) must reactivate a quiesced agent explicitly.

Proposed order:

1. look up the agent
2. if `pollState === "quiesced"`, preflight `tmux.getPaneVar(target, "pane_dead")`
3. if the pane is dead:
   - update public status to `exited`
   - keep terminal metadata intact
   - return a normal manager error instead of pretending the follow-up was accepted
4. if input send succeeds:
   - transition public status to `processing`
   - set `pollState = "active"`
   - clear terminal-finalization and prior delivery metadata
   - persist the reactivated state
5. if input send fails:
   - leave the prior terminal/quiesced state untouched

Do **not** clear delivery state before successful tmux input. Clearing early would reintroduce duplicate-callback risk if the follow-up send fails.

## Rollout Plan

### Stage 1: switch the systemd service to user Bun `1.3.10`

This is outside the repo, but it should happen first because it reduces allocator/RSS pressure immediately and narrows the live blast radius before any behavior change.

Safe rollout:

1. point the systemd `ExecStart` or wrapper to the user Bun `1.3.10` binary
2. restart only the harness service
3. verify:
   - service comes up cleanly
   - tmux interaction still works under systemd
   - RSS slope is lower under the existing polling model
4. leave code unchanged for one observation window before stage 2

Success criterion:

- reduced steady-state RSS growth on the same idle-agent workload, without changing callback semantics yet

### Stage 2: add quiesced/finalizing lifecycle and finalized delivery

Code changes in this repo:

- add persisted terminal lifecycle state
- poll only `active` and `finalizing` agents
- emit finalized terminal event
- send callbacks from finalized snapshots

Success criterion:

- idle/error agents stop being polled after bounded finalization
- follow-up input still works
- terminal callback semantics remain intact

### Stage 3: optional Codex file-read optimization

Only after stage 2 is stable.

Why optional:

- quiescing idle completed agents should remove most of the pathological steady-state polling load
- Codex file-read optimization is still worthwhile, but it should not be mixed into the first correctness-sensitive rollout

Likely follow-up work:

- cache the resolved Codex session file instead of rereading `history.jsonl` every poll
- avoid rereading the entire session file on every poll once offset is known
- consider a lightweight stat/size gate before full text reads

## Test and Verification Plan

### Unit tests

Add/update tests for:

- poll lifecycle transitions: `active -> finalizing -> quiesced`
- cancellation of finalization on new diff
- reactivation on successful `sendInput`
- no reactivation state clear on failed `sendInput`
- `exited` finalization path without assistant message
- final-message stability rule across two reads

Likely files:

- [`src/session/manager.test.ts`](/home/jorge/repos/agent-harness/src/session/manager.test.ts)
- new poller-focused tests
- new persisted terminal-state tests

### Webhook tests

Expand [`src/webhook/client.test.ts`](/home/jorge/repos/agent-harness/src/webhook/client.test.ts) to cover:

- send on `agent_terminal_finalized`, not raw `status_changed`
- duplicate prevention across repeated safety-net cycles
- duplicate prevention across daemon restart with persisted `deliveryState = sent`
- retry from persisted `deliveryState = pending`
- `sendInput` reactivation clears the previous terminal delivery state and allows a new terminal delivery later

### Restart / rehydrate tests

Extend rehydrate coverage so that restart behavior is explicit:

- quiesced + delivered agent comes back quiesced and does not redeliver
- quiesced + pending-delivery agent comes back quiesced and delivery retries
- finalizing agent resumes finalization instead of going fully active forever

Likely file:

- [`src/session/manager.rehydrate.integration.test.ts`](/home/jorge/repos/agent-harness/src/session/manager.rehydrate.integration.test.ts)

### Live verification on vm1

After stage 1 and again after stage 2, verify on the real service:

1. create several Codex agents and let them finish to `idle`
2. confirm they move to `quiesced` internally after the grace window
3. confirm poller no longer rereads their panes/sessions every second
4. confirm callback/webhook payload still contains the final assistant message
5. restart the daemon
6. confirm no duplicate callback/webhook for already-delivered agents
7. send follow-up input to a quiesced but still-live agent
8. confirm it reactivates, returns to `processing`, and later produces one new terminal delivery

### Metrics / logging to watch

During rollout, add temporary logs or debug fields for:

- count of `active`, `finalizing`, `quiesced` agents
- finalization duration
- pending terminal deliveries
- delivery retries
- duplicate-suppression decisions

Those can be temporary if they are too noisy for long-term retention.

## Key Files To Change

Primary code paths:

- [`src/poller/poller.ts`](/home/jorge/repos/agent-harness/src/poller/poller.ts)
- [`src/session/manager.ts`](/home/jorge/repos/agent-harness/src/session/manager.ts)
- [`src/session/store.ts`](/home/jorge/repos/agent-harness/src/session/store.ts)
- [`src/session/types.ts`](/home/jorge/repos/agent-harness/src/session/types.ts)
- [`src/webhook/client.ts`](/home/jorge/repos/agent-harness/src/webhook/client.ts)
- [`src/events/types.ts`](/home/jorge/repos/agent-harness/src/events/types.ts)

New state module:

- [`src/session/terminal-state.ts`](/home/jorge/repos/agent-harness/src/session/terminal-state.ts) (new)

Tests:

- [`src/webhook/client.test.ts`](/home/jorge/repos/agent-harness/src/webhook/client.test.ts)
- [`src/session/manager.test.ts`](/home/jorge/repos/agent-harness/src/session/manager.test.ts)
- [`src/session/manager.rehydrate.integration.test.ts`](/home/jorge/repos/agent-harness/src/session/manager.rehydrate.integration.test.ts)
- new persisted terminal-state test file
- new poller lifecycle test file

Optional later follow-up:

- [`src/poller/codex-internals.ts`](/home/jorge/repos/agent-harness/src/poller/codex-internals.ts)
- [`src/session/messages.ts`](/home/jorge/repos/agent-harness/src/session/messages.ts)
- [`src/webhook-receiver.ts`](/home/jorge/repos/agent-harness/src/webhook-receiver.ts) if `deliveryId` is made first-class in the receiver contract

## Recommended First Implementation Boundary

Keep the first code change set narrow:

1. Bun `1.3.10` service switch outside repo
2. internal `pollState` + persisted terminal state
3. finalized terminal event + webhook client changes
4. tests for quiescing, restart recovery, and reactivation

Do **not** combine that with Codex file-read optimization in the same rollout.
