# Wave 2: Architecture Plan

**Date**: 2026-02-17
**Input**: Wave 1 research + design principles
**Scope**: Module structure, provider abstraction, tmux integration, HTTP API, event system, configuration

---

## Design Decisions

These choices flow from the research findings and design principles:

1. **Interactive mode in tmux**: Agents run in their normal interactive/TUI mode inside tmux windows. Humans see exactly what they'd see if they ran the agent themselves. Status detection uses regex on captured pane output (the CAO pattern). Programmatic modes (stream-json, RPC, HTTP) are deferred as a future alternative integration path.

2. **tmux CLI, not Control Mode**: Shell out to `tmux` via `Bun.spawn()`. Control Mode is well-documented but rarely adopted. CLI + format strings is the battle-tested approach.

3. **No PTY library needed**: tmux manages the PTY. We only run tmux commands as subprocesses, which are simple exec-and-read-stdout operations. No need for `bun-pty`.

4. **In-memory state for MVP**: No SQLite initially. State lives in typed Maps. If we crash, tmux sessions survive and can be reattached manually. Persistence (bun:sqlite) added later if needed.

5. **SSE for event streaming**: One-way stream of normalized events from server to client. No WebSockets for v1 — SSE is simpler and sufficient for read-only event streams.

6. **No Pino**: Design principles say no logging libraries. Simple structured JSONL logger utility.

7. **Input via load-buffer + paste-buffer**: Following CAO's approach — avoids character-by-character issues and handles multi-line input correctly. Fallback to send-keys for simple commands.

---

## 1. Module Structure

```
src/
├── index.ts                    # Entry: load config, start server, start poller
├── config.ts                   # Config loading + validation (Zod)
├── log.ts                      # Structured JSONL logger utility
├── types.ts                    # Shared types: Result, branded IDs, common enums
│
├── tmux/
│   ├── client.ts               # tmux CLI wrapper (all tmux operations)
│   ├── client.test.ts
│   └── types.ts                # TmuxSession, TmuxWindow, TmuxTarget
│
├── providers/
│   ├── types.ts                # Provider interface + AgentStatus enum
│   ├── registry.ts             # Provider lookup by name
│   ├── claude-code.ts          # Claude Code provider
│   ├── claude-code.test.ts
│   ├── codex.ts                # Codex CLI provider
│   ├── codex.test.ts
│   ├── pi.ts                   # Pi coding agent provider
│   ├── pi.test.ts
│   ├── opencode.ts             # OpenCode provider
│   └── opencode.test.ts
│
├── session/
│   ├── manager.ts              # Project + agent lifecycle (create, destroy, list)
│   ├── manager.test.ts
│   ├── store.ts                # In-memory state (Map-based)
│   ├── store.test.ts
│   └── types.ts                # Project, Agent, AgentId
│
├── poller/
│   ├── poller.ts               # Polls tmux panes, detects status changes, emits events
│   ├── poller.test.ts
│   └── differ.ts               # Diffs captured output to detect new content
│
├── events/
│   ├── types.ts                # NormalizedEvent discriminated union
│   ├── bus.ts                  # Typed event emitter (subscribe/emit)
│   └── bus.test.ts
│
└── api/
    ├── app.ts                  # Hono app with all routes
    ├── projects.ts             # Project CRUD endpoints
    ├── agents.ts               # Agent lifecycle + I/O endpoints
    ├── events.ts               # SSE streaming endpoint
    └── health.ts               # Health check endpoint
```

**Module responsibilities:**

| Module | Does | Does NOT |
|--------|------|----------|
| `tmux/client` | Executes tmux commands, parses output | Know about agents or providers |
| `providers/*` | Define CLI commands, parse status/output, format input | Execute tmux commands or manage state |
| `session/manager` | Orchestrates provider + tmux + store | Parse agent output or handle HTTP |
| `session/store` | Hold in-memory state, provide typed accessors | Persist to disk |
| `poller/poller` | Periodically capture panes, run provider parsers, emit events | Handle HTTP or manage sessions |
| `events/bus` | Fan out events to subscribers | Parse agent output |
| `api/*` | Validate HTTP requests, call session manager, stream events | Touch tmux or parse output directly |

---

## 2. Provider Abstraction

### Agent Status

```typescript
type AgentStatus =
  | "starting"       // CLI launched, waiting for initial prompt
  | "idle"           // Ready for input (prompt visible)
  | "processing"     // Working on task (spinner/output streaming)
  | "waiting_input"  // Needs user confirmation (permission prompt, y/n)
  | "error"          // Error state detected
  | "exited";        // Process exited (pane dead or prompt returned to shell)
```

### Provider Interface

```typescript
interface Provider {
  /** Unique provider name: "claude-code" | "codex" | "pi" | "opencode" */
  readonly name: string;

  /** Build the CLI command + args to start this agent */
  buildCommand(config: ProviderConfig): readonly string[];

  /** Environment variables to inject into the tmux window */
  buildEnv(config: ProviderConfig): Record<string, string>;

  /** Parse captured pane output into current status */
  parseStatus(capturedOutput: string): AgentStatus;

  /** Fast idle detection regex — used by poller for quick checks */
  idlePattern(): RegExp;

  /** Format a user message for delivery via tmux send-keys/paste-buffer */
  formatInput(message: string): string;

  /** Command string to gracefully exit the CLI */
  exitCommand(): string;

  /** Extract meaningful events from raw pane output diff (new lines since last capture) */
  parseOutputDiff(diff: string): readonly ProviderEvent[];
}
```

### Provider Events (pre-normalization)

```typescript
/** Raw events extracted by providers before normalization */
type ProviderEvent =
  | { kind: "text"; content: string }
  | { kind: "tool_start"; tool: string; input: string }
  | { kind: "tool_end"; tool: string; output: string }
  | { kind: "error"; message: string }
  | { kind: "completion"; summary: string };
```

### Provider-Specific Notes

| Provider | Start Command | Idle Pattern | Input Method | Known Challenges |
|----------|--------------|--------------|--------------|------------------|
| Claude Code | `claude` (interactive) | `> ` prompt or `$` after `-p` | paste-buffer (multi-line safe) | ANSI codes, non-breaking spaces, `⏺` markers, `✻` spinner |
| Codex | `codex` (interactive) | Prompt pattern (TBD) | paste-buffer | Requires git repo, interactive mode less documented |
| Pi | `pi` (interactive) | Prompt pattern (TBD) | paste-buffer | No MCP, extension-based tools |
| OpenCode | `opencode` (interactive) | Prompt pattern (TBD) | paste-buffer | Task tool subagent hangs (issue #6573) |

**UNKNOWN: Exact idle/processing regex patterns for Codex, Pi, and OpenCode in interactive mode.** The research documents programmatic output formats well, but interactive TUI prompt patterns need empirical testing. Claude Code patterns are documented from CAO: `>` idle, `✻` processing, `⏺` response marker.

### Provider Registry

```typescript
/** Look up provider by name */
function getProvider(name: string): Result<Provider, UnknownProviderError>;

/** List all registered provider names */
function listProviders(): readonly string[];
```

Providers are statically registered (imported and added to a Map). No dynamic plugin loading for v1.

---

## 3. tmux Integration

### Naming Convention

- **Session**: `{prefix}-{projectName}` (e.g., `ah-myproject`)
- **Window**: `{providerName}-{4charHex}` (e.g., `claude-a3f2`)
- **Target string**: `{session}:{window}` (e.g., `ah-myproject:claude-a3f2`)

Prefix defaults to `ah` (agent-harness), configurable.

### TmuxClient Interface

```typescript
interface TmuxClient {
  /** Create a new tmux session with initial window */
  createSession(name: string, cwd: string): Promise<Result<void, TmuxError>>;

  /** Create a new window in an existing session, optionally running a command */
  createWindow(
    session: string,
    name: string,
    cwd: string,
    cmd?: readonly string[],
    env?: Record<string, string>,
  ): Promise<Result<string, TmuxError>>;

  /** Send text input to a pane via load-buffer + paste-buffer */
  sendInput(target: string, text: string): Promise<Result<void, TmuxError>>;

  /** Send a key sequence (e.g., "C-c", "Enter") via send-keys */
  sendKeys(target: string, keys: string): Promise<Result<void, TmuxError>>;

  /** Capture pane content (last N lines) */
  capturePane(target: string, lines: number): Promise<Result<string, TmuxError>>;

  /** Start pipe-pane logging to a file */
  startPipePane(target: string, logPath: string): Promise<Result<void, TmuxError>>;

  /** Stop pipe-pane logging */
  stopPipePane(target: string): Promise<Result<void, TmuxError>>;

  /** Kill a specific window */
  killWindow(target: string): Promise<Result<void, TmuxError>>;

  /** Kill an entire session */
  killSession(name: string): Promise<Result<void, TmuxError>>;

  /** Check if a session exists */
  hasSession(name: string): Promise<boolean>;

  /** List all sessions matching prefix */
  listSessions(prefix: string): Promise<Result<readonly TmuxSessionInfo[], TmuxError>>;

  /** List windows in a session */
  listWindows(session: string): Promise<Result<readonly TmuxWindowInfo[], TmuxError>>;

  /** Get a tmux format variable for a pane */
  getPaneVar(target: string, variable: string): Promise<Result<string, TmuxError>>;

  /** Set environment variable in a session */
  setEnv(session: string, name: string, value: string): Promise<Result<void, TmuxError>>;
}
```

### tmux Types

```typescript
interface TmuxSessionInfo {
  name: string;
  windowCount: number;
  createdAt: number;   // Unix timestamp
  attached: boolean;
}

interface TmuxWindowInfo {
  index: number;
  name: string;
  active: boolean;
  paneId: string;
}

type TmuxError =
  | { code: "SESSION_NOT_FOUND"; session: string }
  | { code: "WINDOW_NOT_FOUND"; target: string }
  | { code: "TMUX_NOT_INSTALLED" }
  | { code: "COMMAND_FAILED"; command: string; stderr: string; exitCode: number };
```

### Implementation Notes

- All methods run `Bun.spawn(["tmux", ...args])` and parse stdout.
- Use `-F` format strings for structured output (e.g., `list-sessions -F "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}"`).
- `sendInput` writes text to a temp file, then runs `tmux load-buffer {path}` + `tmux paste-buffer -t {target} -p -d`. Temp file deleted after paste.
- `capturePane` uses `-p -S -{lines}` flags to capture last N lines to stdout.
- Set `remain-on-exit on` on windows so we can detect process exit via `#{pane_dead}`.

---

## 4. HTTP API Design

Base path: `/api/v1`

### Projects

```
POST   /api/v1/projects
  Body: { name: string, cwd: string }
  Response: 201 { project: Project }
  Creates tmux session, registers in store.

GET    /api/v1/projects
  Response: 200 { projects: Project[] }
  Lists all managed projects.

GET    /api/v1/projects/:name
  Response: 200 { project: Project, agents: AgentSummary[] }
  Project details with agent list.

DELETE /api/v1/projects/:name
  Response: 204
  Kills tmux session, removes from store.
```

### Agents

```
POST   /api/v1/projects/:name/agents
  Body: { provider: string, task: string, model?: string }
  Response: 201 { agent: Agent }
  Creates tmux window, starts provider CLI, sends initial task.

GET    /api/v1/projects/:name/agents
  Response: 200 { agents: Agent[] }

GET    /api/v1/projects/:name/agents/:id
  Response: 200 { agent: Agent, status: AgentStatus, lastOutput: string }
  Includes current status from latest poll and recent output.

POST   /api/v1/projects/:name/agents/:id/input
  Body: { text: string }
  Response: 202 { delivered: true }
  Sends text to agent via tmux paste-buffer.

GET    /api/v1/projects/:name/agents/:id/output
  Query: ?lines=100
  Response: 200 { output: string, lines: number }
  Raw tmux capture-pane output.

POST   /api/v1/projects/:name/agents/:id/abort
  Response: 202 { sent: true }
  Sends Ctrl-C (and possibly Escape first) to the agent pane.

DELETE /api/v1/projects/:name/agents/:id
  Response: 204
  Sends exit command, then kills window if still alive.
```

### Events

```
GET    /api/v1/projects/:name/events
  Query: ?since={eventId}
  Response: SSE stream
  Content-Type: text/event-stream
  Streams NormalizedEvents for all agents in the project.

GET    /api/v1/projects/:name/agents/:id/events
  Query: ?since={eventId}
  Response: SSE stream
  Streams NormalizedEvents for a single agent.
```

### Health

```
GET    /api/v1/health
  Response: 200 {
    uptime: number,
    projects: number,
    agents: number,
    tmuxAvailable: boolean,
    version: string
  }
```

### Response Types

```typescript
interface Project {
  name: string;
  cwd: string;
  tmuxSession: string;
  agentCount: number;
  createdAt: string;     // ISO 8601
}

interface Agent {
  id: string;            // 8-char hex
  provider: string;
  status: AgentStatus;
  task: string;
  windowName: string;
  createdAt: string;
  lastActivity: string;
}

interface AgentSummary {
  id: string;
  provider: string;
  status: AgentStatus;
}

/** All error responses */
interface ApiError {
  error: string;         // Machine-readable code
  message: string;       // Human-readable description
}
```

### Error Codes

| HTTP | Error Code | When |
|------|-----------|------|
| 400 | `INVALID_REQUEST` | Missing/invalid body fields |
| 404 | `PROJECT_NOT_FOUND` | Project name doesn't exist |
| 404 | `AGENT_NOT_FOUND` | Agent ID doesn't exist in project |
| 409 | `PROJECT_EXISTS` | Project name already taken |
| 500 | `TMUX_ERROR` | tmux command failed |
| 503 | `TMUX_UNAVAILABLE` | tmux not installed or not accessible |

---

## 5. Event System

### Normalized Events

```typescript
type EventId = string;  // Monotonic counter or UUID

type NormalizedEvent =
  | {
      id: EventId;
      ts: string;           // ISO 8601
      project: string;
      agentId: string;
      type: "agent_started";
      provider: string;
    }
  | {
      id: EventId;
      ts: string;
      project: string;
      agentId: string;
      type: "status_changed";
      from: AgentStatus;
      to: AgentStatus;
    }
  | {
      id: EventId;
      ts: string;
      project: string;
      agentId: string;
      type: "output";
      text: string;         // New output since last capture
    }
  | {
      id: EventId;
      ts: string;
      project: string;
      agentId: string;
      type: "tool_use";
      tool: string;
      input: string;
    }
  | {
      id: EventId;
      ts: string;
      project: string;
      agentId: string;
      type: "tool_result";
      tool: string;
      output: string;
    }
  | {
      id: EventId;
      ts: string;
      project: string;
      agentId: string;
      type: "error";
      message: string;
    }
  | {
      id: EventId;
      ts: string;
      project: string;
      agentId: string;
      type: "agent_exited";
      exitCode: number | null;
    }
  | {
      id: EventId;
      ts: string;
      project: string;
      agentId: string;
      type: "input_sent";
      text: string;
    };
```

### Event Bus

```typescript
type EventFilter = {
  project?: string;
  agentId?: string;
  types?: ReadonlyArray<NormalizedEvent["type"]>;
};

interface EventBus {
  /** Emit a new event */
  emit(event: NormalizedEvent): void;

  /** Subscribe to events matching a filter. Returns unsubscribe function. */
  subscribe(
    filter: EventFilter,
    callback: (event: NormalizedEvent) => void,
  ): () => void;

  /** Get events since a given event ID (for SSE reconnection) */
  since(eventId: EventId, filter: EventFilter): readonly NormalizedEvent[];
}
```

Implementation: simple in-memory array with a sliding window (keep last N events for replay on SSE reconnect). Subscribers stored in an array, filtered on emit.

### Event Flow

```
┌─────────┐     capture-pane      ┌──────────┐    parseStatus()     ┌──────────┐
│  tmux   │ ──────────────────► │  Poller  │ ──────────────────► │ Provider │
│  pane   │                      │          │    parseOutputDiff() │          │
└─────────┘                      └──────────┘                      └──────────┘
                                      │                                 │
                                      │ NormalizedEvent                 │ ProviderEvent
                                      ▼                                 │
                                 ┌──────────┐     normalize()      ◄────┘
                                 │ EventBus │
                                 └──────────┘
                                   │      │
                          subscribe()  subscribe()
                                   │      │
                                   ▼      ▼
                              ┌──────┐  ┌──────┐
                              │ SSE  │  │ Store │  (update agent.status, agent.lastActivity)
                              │ conn │  │      │
                              └──────┘  └──────┘
```

### Poller Behavior

- Runs on a configurable interval (default: 1000ms).
- For each active agent:
  1. `capturePane()` — get last N lines.
  2. Diff against previous capture (detect new content).
  3. `provider.parseStatus()` — detect current status.
  4. If status changed → emit `status_changed` event, update store.
  5. `provider.parseOutputDiff()` on new content → emit `output` / `tool_use` / `tool_result` / `error` events.
- Checks `#{pane_dead}` to detect exited agents → emit `agent_exited`.

**UNKNOWN: Optimal polling interval.** 1000ms is a starting point. May need adaptive polling (faster when processing, slower when idle) to balance responsiveness and CPU.

---

## 6. Configuration

### Config File

Location: `harness.json` in project root (or `HARNESS_CONFIG` env var).

```typescript
interface HarnessConfig {
  /** HTTP server port. Default: 7070 */
  port: number;

  /** tmux session name prefix. Default: "ah" */
  tmuxPrefix: string;

  /** Directory for pipe-pane logs. Default: "./logs" */
  logDir: string;

  /** Log level. Default: "info" */
  logLevel: "debug" | "info" | "warn" | "error";

  /** Status polling interval in ms. Default: 1000 */
  pollIntervalMs: number;

  /** Lines to capture from tmux panes. Default: 500 */
  captureLines: number;

  /** Max events to keep in memory for SSE replay. Default: 10000 */
  maxEventHistory: number;

  /** Provider-specific configuration */
  providers: Record<string, ProviderConfig>;
}

interface ProviderConfig {
  /** Path to CLI binary. Default: provider name (found via PATH) */
  command: string;

  /** Extra CLI arguments appended to default command */
  extraArgs: readonly string[];

  /** Extra environment variables for the agent process */
  env: Record<string, string>;

  /** Default model override */
  model?: string;

  /** Whether this provider is enabled. Default: true */
  enabled: boolean;
}
```

### Default Config

```json
{
  "port": 7070,
  "tmuxPrefix": "ah",
  "logDir": "./logs",
  "logLevel": "info",
  "pollIntervalMs": 1000,
  "captureLines": 500,
  "maxEventHistory": 10000,
  "providers": {
    "claude-code": {
      "command": "claude",
      "extraArgs": [],
      "env": {},
      "enabled": true
    },
    "codex": {
      "command": "codex",
      "extraArgs": [],
      "env": {},
      "enabled": true
    },
    "pi": {
      "command": "pi",
      "extraArgs": [],
      "env": {},
      "enabled": true
    },
    "opencode": {
      "command": "opencode",
      "extraArgs": [],
      "env": {},
      "enabled": true
    }
  }
}
```

Validation via Zod schema. Missing fields fall back to defaults. Extra fields rejected.

---

## Flagged Unknowns

These were not resolved by the Wave 1 research and need empirical testing:

| # | Unknown | Impact | Suggested Resolution |
|---|---------|--------|---------------------|
| 1 | **Interactive TUI patterns for Codex, Pi, OpenCode** | Cannot implement `parseStatus()` or `idlePattern()` without knowing exact prompt strings | Run each agent interactively, capture output, document patterns |
| 2 | **Optimal polling interval** | Too fast wastes CPU, too slow misses events | Start at 1000ms, measure, consider adaptive polling |
| 3 | **ANSI escape code handling** | capture-pane may include ANSI codes depending on flags | Test with `-e` flag (preserve escapes) vs without; strip for parsing, preserve for display |
| 4 | **Multi-line input edge cases** | Some agents may interpret pasted multi-line input differently | Test load-buffer+paste-buffer with each agent, verify bracketed paste mode |
| 5 | **OpenCode subagent hang (issue #6573)** | May affect reliability when OpenCode spawns subagents | Monitor for hangs, implement timeout + abort fallback |
| 6 | **Permission prompt handling** | Agents may ask for user confirmation (y/n) — unclear if API should auto-approve or relay | Expose as `waiting_input` status; let API caller decide via `/input` endpoint |
| 7 | **tmux history memory** | Long-running agents accumulate scrollback — unclear memory impact | Set `history-limit` per window, test with large outputs |
| 8 | **Crash recovery** | If harness crashes, tmux sessions survive but state is lost | On startup, scan for orphaned `{prefix}-*` sessions and optionally reclaim |

---

## Dependency Summary

| Package | Purpose | Justification |
|---------|---------|---------------|
| `hono` | HTTP framework | Design principles: allowed framework |
| `zod` | Config + request validation | Design principles: allowed framework |
| `typescript` | Type checking | Required |

**That's it.** Three dependencies. Everything else is Bun built-ins (`Bun.spawn`, `bun:test`, `bun:sqlite` if needed later) or custom code.

---

## Startup Sequence

1. Load and validate `harness.json` (Zod).
2. Verify tmux is installed and accessible.
3. Initialize in-memory store.
4. Initialize event bus.
5. Start poller (setInterval).
6. Mount Hono routes.
7. Start HTTP server on configured port.
8. Log startup info to stderr.

## Shutdown Sequence

1. Stop accepting new HTTP requests.
2. Stop poller.
3. For each active agent: send exit command, wait briefly.
4. Close SSE connections.
5. **Do NOT kill tmux sessions** — leave them for manual inspection.
6. Log shutdown to stderr.
7. Exit.
