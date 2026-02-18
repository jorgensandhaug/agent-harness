# Inspector v1 Spec

Date: 2026-02-17  
Status: proposed

## Problem
Current `bun run smoke` is weak for debugging harness correctness.
Need tool to compare:
- harness observed state/events
- tmux ground truth TUI state

In real time, while still driving agents through normal API.

## Goals
- Show full live control-plane state for one+ agents.
- Make harness-vs-tmux mismatch obvious quickly.
- Allow interactive debugging actions (input/abort/delete/replay).
- Use existing HTTP/SSE API paths by default.

## Non-goals (v1)
- No production auth/multi-user hardening.
- No full embedded tmux terminal in browser (complex PTY bridge).
- No replacing tmux as source of truth.

## Core User Workflows
1. Create project + agent from inspector.
2. See status/event/output updates continuously.
3. Open tmux attach command and compare side-by-side.
4. Send input manually.
5. Abort/restart/delete quickly.
6. Reconnect SSE with `since` and verify replay.

## UX Shape (Inspector UI)
- Left pane: projects + agents list
- Top center: selected agent summary
- Center: live event timeline
- Bottom: raw `/output` capture snapshot
- Right controls: create agent, send input, abort, delete, reconnect stream

Header should always show:
- provider
- project
- agent id
- tmux target + `tmux attach -t <session>`
- current harness status
- last transition time
- stream connected/disconnected
- last event id / replay since id

## Required Internal Visibility
Need these surfaced explicitly:
- status transitions
- event counts per type
- last poll timestamp
- last capture size
- last diff size
- last parse warnings/errors
- `pane_dead`
- `pane_current_command`

Without these, mismatch debugging stays guessy.

## API Contract
Reuse existing endpoints:
- `POST /api/v1/projects`
- `GET /api/v1/projects`
- `POST /api/v1/projects/:name/agents`
- `GET /api/v1/projects/:name/agents/:id`
- `POST /api/v1/projects/:name/agents/:id/input`
- `POST /api/v1/projects/:name/agents/:id/abort`
- `GET /api/v1/projects/:name/agents/:id/output`
- `GET /api/v1/projects/:name/agents/:id/events?since=...`

Add debug endpoint:
- `GET /api/v1/projects/:name/agents/:id/debug`

Response shape:
```ts
type AgentDebug = {
  poll: {
    lastPollAt: string | null;
    pollIntervalMs: number;
    captureLines: number;
    lastCaptureBytes: number;
    lastDiffBytes: number;
  };
  tmux: {
    paneDead: boolean | null;
    paneCurrentCommand: string | null;
  };
  parser: {
    lastParsedStatus: string | null;
    lastProviderEventsCount: number;
    lastWarnings: readonly string[];
  };
  stream: {
    lastEventId: string | null;
    emittedCounts: Record<string, number>;
  };
  errors: readonly {
    ts: string;
    scope: "poll" | "capture" | "parse" | "tmux" | "api";
    message: string;
  }[];
};
```

## Architecture
Two-process local dev model:
- Harness server (existing)
- Inspector UI client (new)

Inspector must call API only. no direct module calls.
Reason: validate real routing/manager/poller/event behavior.

## TUI vs Web (decision)
### Terminal UI
Pros:
- zero browser
- can reuse current smoke runtime
Cons:
- poor multi-pane interaction
- hard forms/filtering/search/replay UX
- hard to inspect large event payloads
- side-by-side with attached tmux awkward

### Web UI
Pros:
- easiest rich layout + controls
- easy side-by-side panels
- easy event filtering/search/copy
- easier reconnection/debug indicators
Cons:
- extra static UI code
- still cannot show true tmux TUI without PTY bridge

### Decision
Use **web UI** for Inspector v1.

Ground truth tmux remains external:
- show one-click copy attach command
- recommend split-screen: browser inspector + terminal tmux attach

PTY embed can be v2+ if truly needed.

## Delivery Plan
### Phase 1 (fast, useful)
- New `bun run inspect`
- Static web page served by tiny Hono route or separate file server
- Uses existing endpoints only
- Features:
  - create project/agent
  - send input/abort/delete
  - live SSE timeline
  - output snapshot polling
  - status + transition log
  - attach command copy

### Phase 2 (deep debug)
- Add `/debug` endpoint
- Show poll/tmux/parser internals
- show mismatch badges:
  - `status=processing` but `pane_current_command` idle
  - no events for N sec while output changes

### Phase 3 (power features)
- event replay explorer (`since` cursor picker)
- session recording export (jsonl)
- compare two providers side-by-side

## Acceptance Criteria (v1)
- Can drive full lifecycle from UI without curl/manual scripts.
- Can see status/event/output update within <=1s cadence.
- Can reconnect stream with `since` and confirm replay.
- Can spot and prove at least one real mismatch case.
- Can keep/delete project+agent from UI.

## Risks
- Added debug fields may increase in-memory state size.
- Poll/debug bookkeeping must not affect agent stability.
- UI can mask race bugs unless raw event ids/timestamps always visible.

## Open Questions
- Should inspect mode expose all providers by default or user allowlist?
- Should debug endpoint be always on or gated by `HARNESS_DEBUG_API=1`?
- Need persistent debug history or just in-memory rolling window?
