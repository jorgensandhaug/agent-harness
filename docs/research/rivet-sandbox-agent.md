# Rivet Sandbox Agent — Deep Dive Research

**Research Date**: 2026-02-17
**Source**: https://github.com/rivet-dev/sandbox-agent

---

## 1. Architecture

**Runtime**: Rust (static binary) + TypeScript SDK
**Purpose**: Universal HTTP+SSE API for running coding agent CLIs (Claude Code, Codex, OpenCode, Amp, Pi, Cursor) inside sandboxes

**Three deployment modes:**
1. **Embedded** — TypeScript SDK spawns Rust binary as subprocess, auto-manages lifecycle
2. **Server** — Standalone daemon in sandbox (E2B, Daytona, Docker), clients connect via HTTP
3. **CLI** — Direct invocation for one-off operations

**Stack:**
- **Server**: Rust (Axum web framework, Tokio async runtime)
- **SDK**: TypeScript (Node.js, Bun, browser with polyfills)
- **Inspector UI**: React + Vite (embedded in binary via `include_dir`)
- **Agent binaries**: Downloaded from CDN or GitHub releases, cached locally

**Key modules** (Rust workspace):
- `sandbox-agent` — HTTP router, session manager, CLI parser
- `agent-management` — Agent binary installation, version detection, credential extraction
- `acp-http-adapter` — ACP (Agent Client Protocol) JSON-RPC bridge
- `opencode-adapter` — OpenCode HTTP API compatibility layer
- `opencode-server-manager` — Manages long-running OpenCode server processes

**Design principles:**
- Single binary, no runtime dependencies (static linking, musl on Linux)
- Agent-agnostic — clients write once, swap agents via config
- Event streaming first — SSE for all async operations
- No disk persistence — sessions are ephemeral, events streamed to external storage

---

## 2. Agent Wrapping

**Two architectural patterns:**

### Subprocess Model (Claude Code, Amp, Pi)
New process spawned **per message/turn**. Process terminates after turn completes. Multi-turn via CLI resume flags (`--resume`, `--continue`).

**Example (Claude Code):**
```bash
claude --print --output-format stream-json --verbose \
  --model claude-opus-4 --resume SESSION_ID \
  --permission-mode plan \
  PROMPT
```

Each line on stdout is a JSON event. Process exits when turn completes.

### Server Model (Codex, OpenCode)
Single **long-running server process**. Multiple sessions multiplexed via JSON-RPC or HTTP.

**Codex** — JSON-RPC over stdio:
```bash
codex app-server  # Runs indefinitely
```
- `initialize` / `initialized` handshake on startup
- `thread/start` → returns `thread_id`
- `turn/start` with `thread_id` to send messages
- Notifications routed by `thread_id`

**OpenCode** — HTTP server:
```bash
opencode serve --port 4200
```
- `POST /session` → create session
- `POST /session/{id}/prompt` → send message
- `GET /event/subscribe` → SSE stream

**Abstraction layer**: `AcpProxyRuntime` manages both patterns. For subprocess agents, it spawns+parses stdout. For server agents, it maintains a single process and routes requests via JSON-RPC or HTTP.

**Agent installation**: Binaries downloaded from ACP registry (CDN) or GitHub releases. Registry JSON defines download URLs per platform. Local caching in `~/.local/share/sandbox-agent/bin/`.

**Credential handling**: Extracts API keys from:
- Agent config files (`~/.config/claude/config.json`, `~/.codex/config.toml`)
- OAuth tokens (Anthropic, OpenAI)
- Environment variables
- Provides `sandbox-agent credentials extract-env --export` to generate env vars

---

## 3. Session Management

**In-memory only** — no disk persistence:
```rust
struct SessionManager {
    sessions: Mutex<HashMap<String, SessionState>>,
}

struct SessionState {
    session_id: String,
    agent: AgentId,
    events: Vec<UniversalEvent>,
    pending_questions: Vec<String>,
    pending_permissions: Vec<String>,
    broadcaster: tokio::sync::broadcast::Sender<Event>,
    ended: bool,
}
```

**Lifecycle:**
1. `POST /v1/acp/{server_id}` with `initialize` method → creates ACP server instance
2. `session/new` method → creates session, returns `agentSessionId`
3. `session/prompt` method → spawns agent subprocess (or sends to server), streams events
4. Process terminates → session marked `ended`

**Event streaming:**
- Each event gets monotonically increasing ID
- Stored in-memory vector per session
- `GET /v1/acp/{server_id}` (SSE) → subscribe to new events
- `last-event-id` header for resume-from-offset

**Session ID mapping:**
- **Client session ID** (`server_id` in ACP) — primary key, client-provided
- **Agent session ID** — underlying agent's thread/session ID, surfaced in events

---

## 4. API Surface

**HTTP + SSE** (no WebSockets in current implementation):

### ACP Endpoints (JSON-RPC over HTTP)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/acp/{server_id}` | Send JSON-RPC envelope (initialize, session/new, session/prompt) |
| `GET` | `/v1/acp/{server_id}` | SSE stream of JSON-RPC notifications |
| `DELETE` | `/v1/acp/{server_id}` | Shutdown server instance |

**JSON-RPC methods** (ACP protocol):
- `initialize` — handshake, returns capabilities
- `session/new` — create session, returns `agentSessionId`
- `session/prompt` — send message, returns `promptId`
- `session/cancel` — cancel pending prompt
- `permission/respond` — approve/deny file changes
- `question/respond` — answer HITL questions

### Agent Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/agents` | List available agents + install status |
| `GET` | `/v1/agents/{agent}` | Get agent info |
| `POST` | `/v1/agents/{agent}/install` | Install/reinstall agent binary |

### Filesystem Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/fs/entries` | List directory |
| `GET` | `/v1/fs/file` | Read file |
| `PUT` | `/v1/fs/file` | Write file |
| `DELETE` | `/v1/fs/entry` | Delete file/dir |
| `POST` | `/v1/fs/mkdir` | Create directory |
| `POST` | `/v1/fs/move` | Rename/move |
| `POST` | `/v1/fs/upload-batch` | Upload tar.gz archive |

### Config Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET/PUT/DELETE` | `/v1/config/mcp` | Manage MCP server config |
| `GET/PUT/DELETE` | `/v1/config/skills` | Manage skills config |

### OpenCode Compatibility Layer

Separate router (`/opencode`) implements OpenCode HTTP API, translating to ACP internally:
- `POST /session` → ACP `session/new`
- `POST /session/{id}/prompt` → ACP `session/prompt`
- `GET /event/subscribe` → SSE (maps ACP events to OpenCode format)
- `POST /question/reply`, `/permission/reply` → ACP response methods

**Inspector UI**: Embedded React app at `/ui/`, provides session explorer, event viewer, file browser.

---

## 5. Communication

### Three communication layers

**1. Client ↔ Sandbox Agent (HTTP + SSE)**
- Client sends HTTP POST to `/v1/acp/{server_id}`
- Server returns SSE stream of events
- Each event = JSON-RPC notification with `id`, `method`, `params`

**2. Sandbox Agent ↔ Agent CLI (varies by agent)**
- **Claude/Amp/Pi**: JSONL over stdout, spawn per turn
- **Codex**: JSON-RPC over stdio, single persistent process
- **OpenCode**: HTTP + SSE to `localhost:4200`

**3. Universal Event Schema**

All agent-specific events normalized to `UniversalEvent`:

```rust
struct UniversalEvent {
    id: u64,
    timestamp: i64,
    session_id: String,
    agent: AgentId,
    data: UniversalEventData,
}

enum UniversalEventData {
    Message(UniversalMessage),
    Started,
    Ended { code: i32 },
    Error { message: String },
    QuestionAsked { id, question, options },
    PermissionAsked { id, path, action },
    Unknown(Value),
}
```

**Converters** in `server/packages/universal-agent-schema/src/agents/{agent}.rs`:
- Parse agent-specific JSON events
- Map to universal schema
- Preserve unparseable data in `Unknown` or `Unparsed` variants

**No MCP integration** (yet) — MCP servers configured via JSON, passed to agents as env/config, but no MCP protocol implementation in sandbox-agent itself.

---

## 6. Sandboxing

**Critical: Sandbox Agent does NOT provide sandboxing itself.** It's designed to run **inside** an existing sandbox (E2B, Daytona, Docker, Fly Machines, etc.).

**Sandboxing strategy:**
1. Deploy Sandbox Agent binary to isolated environment
2. Agent CLIs execute commands in that environment
3. Isolation provided by container/VM layer (Docker, Firecracker, gVisor, etc.)

**No nsjail/firejail** — relies on platform-level isolation.

**Environment detection**: Checks for `E2B_SANDBOX=true`, `VERCEL=1`, `MODAL_IS_REMOTE=1`, Fly.io, etc.

**Deployment examples:**
- **E2B**: `curl install.sh | sh` in E2B sandbox, bind to 0.0.0.0
- **Daytona**: Similar install, connect via workspace URL
- **Docker**: `FROM debian:bookworm`, install binary, `EXPOSE 2468`
- **Vercel (experimental)**: Edge Function wraps SDK in embedded mode

**Process isolation**: Agent processes run as subprocesses of sandbox-agent daemon. If sandbox provider kills root process → all agents terminate.

---

## 7. Ideas Worth Borrowing (for agent-harness)

### Borrow

**1. Universal event schema** — Single normalized event format across agents. Strict typing (Zod). Preserves unknown fields for debugging. Makes agent swapping trivial.

**2. Embedded + Server dual modes** — Embedded: SDK spawns daemon, auto-cleanup on exit. Server: persistent daemon, multiple clients. Same API for both.

**3. Agent installation abstraction** — Central registry (JSON manifest with download URLs). Platform detection (os/arch). Lazy install on first use. Version locking.

**4. Credential extraction** — Auto-detect API keys from agent configs. Export as env vars for injection. Supports OAuth tokens.

**5. Multi-turn via resume flags** — Claude Code pattern: `--resume SESSION_ID` allows subprocess-per-turn without losing context. Simpler than persistent server for stateless agents.

**6. TypeScript SDK patterns:**
```ts
// Embedded mode
const client = await SandboxAgent.start();
// Server mode
const client = await SandboxAgent.connect({ baseUrl, token });
// Same API both ways
const session = await client.createSession({ agent: "claude" });
await session.prompt({ prompt: "Hello" });
for await (const event of session.events()) { ... }
```

**7. Health checks + graceful shutdown** — `/v1/health` endpoint. Daemon waits for readiness. Cleanup on Ctrl+C (kills agent processes).

**8. Inspector UI** — Embedded React app. Session explorer, event viewer, filesystem browser. Useful for debugging live sessions.

**9. Filesystem API** — Essential for observability: list, read, write, upload batch. See what agents created, inspect changes.

**10. Persistent process design** (from their research docs):
- Decouple process lifetime from connection lifetime
- WebSocket for PTY I/O (low-latency, bidirectional)
- REST for commands (request-response, structured output)
- SSE for process lifecycle events
- Tag-based process selection (not just PID)

### Don't Borrow

**1. Rust for daemon** — agent-harness spec is Bun+TS
**2. No disk persistence** — agent-harness should persist sessions to SQLite
**3. ACP complexity** — JSON-RPC envelope adds indirection, direct REST may be simpler
**4. OpenCode compat layer** — unnecessary for agent-harness
**5. Embedded TypeScript SDK** — agent-harness is daemon-only

### Novel Additions for agent-harness (not in Sandbox Agent)

**Tmux integration**: Agent runs in tmux pane → poller captures pane content → HTTP API exposes snapshots → terminal replay for debugging. Better observability than parsing stdout alone.

**Filesystem monitoring**: `inotify`/`fswatch` on workspace → event stream of file changes → correlate with agent events → catch agents bypassing declared tools.

**Session persistence**: SQLite for session history → resume from disk after daemon restart → export/import sessions.

---

## Summary Comparison

| Aspect | Rivet Sandbox Agent | Agent Harness |
|--------|---------------------|---------------|
| **Language** | Rust + TypeScript SDK | Bun + TypeScript |
| **Architecture** | Universal API abstraction | Tmux-based harness |
| **Agent wrapping** | Subprocess + server models | Subprocess in tmux panes |
| **Session storage** | In-memory only | Persistent (SQLite) |
| **Communication** | HTTP + SSE | HTTP + SSE |
| **Sandboxing** | Runs inside sandbox (E2B, etc.) | Local or remote NixOS hosts |
| **Observability** | Event stream + Inspector UI | Tmux pane capture + polling |
| **Deployment** | Embedded or server | Daemon-only |
| **Filesystem API** | Full API | Similar + inotify monitoring |
| **MCP** | Config only, no protocol | Could implement MCP bridge |

**Key insight**: Sandbox Agent solves "run agents remotely in isolated sandboxes". Agent Harness solves "observe and control local agents with full terminal visibility". Complementary, not competing.

---

## Unknowns

1. **ACP protocol spec**: The Agent Client Protocol (ACP) appears to be a Rivet-originated standard. Unclear if other tools will adopt it or if it's a de facto proprietary protocol.
2. **Performance under load**: No benchmarks found for concurrent sessions or event throughput.
3. **Memory growth**: In-memory event storage with no eviction — unclear how this handles long-running sessions.
4. **Codex `app-server` subcommand**: This JSON-RPC mode for Codex is not documented in OpenAI's public docs. May be an internal/undocumented API.
5. **Inspector UI completeness**: Embedded in binary but unclear how feature-complete (e.g., can it send prompts or is it read-only?).
6. **OpenCode adapter fidelity**: Unclear how complete the OpenCode API compatibility is.

---

## Sources

- [GitHub: rivet-dev/sandbox-agent](https://github.com/rivet-dev/sandbox-agent)
- Source code analysis: `server/`, `sdk/`, `agent-management/`, `acp-http-adapter/`, `opencode-adapter/`
- `process-terminal-design.md` (internal research doc in repo)
