# Wave 1 Research: Agent Orchestration Harness

**Research Date**: 2026-02-17
**Scope**: Building a Bun+TypeScript daemon wrapping multiple coding agent CLIs (Claude Code, Codex, Pi, OpenCode) behind a unified HTTP API with tmux session management.

---

## Table of Contents

1. [AWS CLI Agent Orchestrator (CAO)](#1-aws-cli-agent-orchestrator-cao)
2. [Agent CLI Programmatic Modes](#2-agent-cli-programmatic-modes)
3. [tmux Programmatic Control](#3-tmux-programmatic-control)
4. [Bun + TypeScript Specifics](#4-bun--typescript-specifics)
5. [Prior Art Survey](#5-prior-art-survey)
6. [Key Findings & Recommendations](#6-key-findings--recommendations)

---

## 1. AWS CLI Agent Orchestrator (CAO)

### Architecture Overview

CAO is a **hierarchical multi-agent orchestration system** (~8000 LOC Python) that coordinates multiple AI CLI agents (Claude Code, Amazon Q CLI, Kiro CLI, Codex CLI) through tmux sessions and MCP (Model Context Protocol).

**Core architecture pattern:**
```
CLI/MCP Entry Points → FastAPI HTTP Server → Services Layer → Clients (tmux, SQLite) → Providers → CLI Tools
```

**Key components:**
- **FastAPI server** (port 9889): Central orchestration hub exposing REST APIs
- **Tmux client**: Session/window management with `libtmux` wrapper
- **SQLite database**: Metadata storage (terminals, inbox messages, flows)
- **Provider abstraction**: CLI tool adapters (Q CLI, Claude Code, Kiro CLI, Codex)
- **MCP server**: Tools for inter-agent communication (`handoff`, `assign`, `send_message`)
- **Watchdog observer**: File-based inbox message delivery monitoring

### Tmux Session Management

**Design decisions:**
- Each agent runs in a **separate tmux window** within a shared session
- Terminal ID assigned via `CAO_TERMINAL_ID` environment variable (8-char hex)
- Sessions prefixed with `cao-` for easy identification
- Windows named: `{agent_profile}-{4-char-suffix}` (e.g., `developer-a3f2`)

**Key mechanisms:**

1. **Session/window creation**:
   - Uses `libtmux` library (not subprocess tmux commands)
   - Sets environment: `CAO_TERMINAL_ID` before spawning
   - Supports explicit working directory per terminal

2. **History capture**:
   - `capture-pane -e -p -S -{lines}` for retrieving terminal output
   - Configurable tail lines (default: 2000 from `TMUX_HISTORY_LINES`)
   - Used for status detection and output extraction

3. **Input delivery**:
   - Uses `tmux load-buffer` + `paste-buffer -p` (not `send-keys`)
   - Avoids character-by-character chunking issues
   - Bracketed paste mode prevents multi-line breaks

4. **Pipe-pane logging**:
   - Each terminal streams output to `~/.cao/logs/{terminal_id}.log`
   - Enables file-based watchdog monitoring for inbox delivery
   - Started on terminal creation, stopped on deletion

### Provider Abstraction Pattern

**Base interface** (`BaseProvider` ABC):
```python
- initialize() → bool                           # Start CLI tool
- get_status(tail_lines) → TerminalStatus       # Parse output for state
- get_idle_pattern_for_log() → str             # Fast idle detection
- extract_last_message_from_script(str) → str  # Parse final response
- exit_cli() → str                              # Graceful shutdown command
- cleanup() → None                              # Resource cleanup
```

**Status detection** (regex-based, provider-specific):
- `IDLE`: Ready for input
- `PROCESSING`: Working on task
- `COMPLETED`: Task finished, output available
- `WAITING_USER_ANSWER`: Needs user selection/confirmation
- `ERROR`: Failure state

**Provider implementations:**

1. **ClaudeCodeProvider**:
   - Detects `⏺` response marker, `>` idle prompt, `✻…` processing spinner
   - Handles ANSI codes, non-breaking spaces
   - Supports `--append-system-prompt` and `--mcp-config` flags

2. **QCliProvider**:
   - Waits for shell, then runs `q chat --agent {profile}`
   - Detects `>` green arrow (response), `[agent_profile] >` idle prompt
   - Permission prompt handling (`Allow this action? [y/n/t]:`)

### HTTP API Design

**Endpoints:**
```
Sessions:
  POST   /sessions                      # Create session + first terminal
  GET    /sessions                      # List all sessions
  DELETE /sessions/{name}               # Kill session + all terminals

Terminals:
  POST   /sessions/{name}/terminals     # Add terminal to session
  GET    /terminals/{id}                # Get terminal metadata + live status
  POST   /terminals/{id}/input          # Send message
  GET    /terminals/{id}/output         # Get history (mode: full|last)
  POST   /terminals/{id}/exit           # Send provider exit command
  DELETE /terminals/{id}                # Remove terminal

Inbox:
  POST   /terminals/{id}/inbox/messages # Queue message for delivery
  GET    /terminals/{id}/inbox/messages # List inbox (filter by status)
```

### Supervisor/Worker Pattern

**Three orchestration modes**:

1. **Handoff (Synchronous)**:
   - Creates terminal → waits for IDLE → sends input → polls until COMPLETED
   - Blocks calling agent until completion

2. **Assign (Asynchronous)**:
   - Creates terminal → sends input immediately → returns terminal_id
   - Worker must include callback instructions in message

3. **Send Message (Queued Communication)**:
   - Creates `InboxMessage` with status=PENDING
   - Watchdog monitors log for idle pattern
   - Messages delivered in order when receiver idle

### MCP Usage

**Tool registration:**
```python
@mcp.tool()
async def handoff(...) -> HandoffResult
async def assign(...) -> Dict[str, Any]
async def send_message(...) -> Dict[str, Any]
```

**Communication flow:**
1. Agent calls MCP tool (stdio protocol)
2. MCP server reads `CAO_TERMINAL_ID` from environment
3. Makes HTTP request to FastAPI server (localhost:9889)
4. Server performs orchestration action
5. Returns result to MCP client → agent

### Strengths

1. **Clean provider abstraction**: Adding new CLI tools requires only implementing 6 methods
2. **Human-inspectable orchestration**: `tmux attach` lets developers see exactly what agents are doing
3. **Tmux environment injection**: `CAO_TERMINAL_ID` elegantly identifies agents
4. **Inbox queuing with watchdog**: Avoids polling every terminal, scales to many agents
5. **Three orchestration modes**: Handoff/assign/send_message cover sync/async/messaging patterns
6. **Status detection without CLI APIs**: Regex-based parsing works with any CLI tool

### Limitations

1. **Tmux dependency**: Hard requirement (v3.3+) limits portability (Windows, containerized envs)
2. **Regex brittle to format changes**: Q CLI/Claude Code updates could break status detection
3. **No timeout for async workers**: Assign pattern has no built-in worker timeout
4. **No authentication**: Localhost-only assumption, no multi-user support
5. **Synchronous terminal operations**: FastAPI async not fully leveraged
6. **No agent lifecycle management**: Orphaned terminals if server crashes

### Unknowns

1. **Performance under load**: How many concurrent agents before tmux/SQLite bottlenecks?
2. **Memory usage**: Does tmux history accumulation cause issues with long-running agents?
3. **Cleanup guarantees**: What happens to tmux sessions if server exits uncleanly?
4. **Provider status race conditions**: Could concurrent get_status() calls cause issues?

---

## 2. Agent CLI Programmatic Modes

### Claude Code

**Primary flags:**
- `-p` or `--print` - Run non-interactively
- `--output-format text|json|stream-json` - Output format
- `--allowedTools <tools>` - Auto-approve specific tools
- `--json-schema <schema>` - Request structured output
- `--continue` / `--resume <session_id>` - Session resumption

**Output formats:**

JSON format (`--output-format json`):
```json
{
  "result": "text result here",
  "session_id": "session-uuid",
  "structured_output": {},
  "duration_ms": 12345,
  "total_cost_usd": 0.05,
  "usage": {}
}
```

Stream JSON format (`--output-format stream-json`):
- Newline-delimited JSON events
- Event types: `system`, `assistant`, `stream_event`, `result`

**Event schemas:**

- `type: "system", subtype: "init"` - Agent initialized
- `type: "assistant"` - Agent working/responding
- `type: "result", subtype: "success"` - Completed successfully
- `type: "result", subtype: "error_*"` - Failed with error

**Agent SDK** (`@anthropic-ai/claude-agent-sdk`):
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = query({
  prompt: "Your task",
  options: {
    allowedTools: ["Read", "Edit"],
    outputFormat: { type: "json_schema", schema: {...} },
    canUseTool: async (tool, input, options) => {},
    hooks: {},
  }
});

for await (const message of result) {
  if (message.type === "result") {
    console.log(message.result);
  }
}
```

**Capabilities:**
- Multi-turn conversations with full tool use
- Structured output with JSON Schema validation
- Token-by-token streaming
- Session continuation
- Programmatic permission control

**Limitations:**
- Skills (e.g., `/commit`) only available in interactive mode
- Cannot interact with permission prompts in headless mode

### Codex CLI

**Primary command:**
- `codex exec "<task>"` - Run non-interactively
- `--json` - Output JSON Lines (JSONL) format
- `--full-auto` - Allow file edits
- `--output-schema <path>` - Request JSON Schema-conforming response
- `codex exec resume --last "<task>"` - Continue previous run

**Event schemas (JSONL):**

- `thread.started` - Execution initialized
- `turn.started` / `turn.completed` - Turn lifecycle
- `item.started` / `item.completed` - Tool/action lifecycle
- `turn.failed` / `error` - Error states

**Item types:**
- `agent_message` - Final responses
- `command_execution` - Bash commands
- `file_change` - File modifications
- `mcp_tool_call` - MCP tool invocations

**Capabilities:**
- JSONL streaming
- JSON Schema output validation
- Session resumption
- Real-time progress via item events

**Limitations:**
- Requires Git repository by default
- Default mode is read-only (requires `--full-auto`)
- `aggregated_output` truncated to 64 KiB

### Pi Coding Agent

**Mode flags:**
- `--mode rpc` - RPC protocol over stdin/stdout
- `--mode print` - Print mode (one-shot execution)
- `--mode json` - JSON output mode
- `--no-session` - Ephemeral mode
- `-c` / `--continue` - Resume most recent session

**RPC Protocol:**

All commands are JSON objects sent to stdin. Core commands:

**`prompt`** - Send user message:
```json
{
  "type": "prompt",
  "id": "optional-req-id",
  "text": "Your message",
  "streamingBehavior": "steer" | "followUp"
}
```

**`get_state`** - Query current state:
```json
{"type": "get_state"}
```

**Other commands**: `get_messages`, `set_model`, `set_thinking_level`, `abort`, `new_session`, `bash`

**Event schemas:**

- `agent_start` - Agent initialized
- `turn_start` / `turn_end` - Turn lifecycle
- `message_start` / `message_update` / `message_end` - Message streaming
- `tool_execution_start` / `tool_execution_end` - Tool lifecycle

**Capabilities:**
- Full RPC integration
- Token-by-token streaming
- Multi-turn conversations
- Session forking
- Model switching mid-conversation
- Extension system for custom tools

**Limitations:**
- Explicitly excludes MCP integration (use extensions)
- No built-in sub-agents
- No permission dialogs

### OpenCode

**Core commands:**
- `opencode run` - Non-interactive execution
- `opencode serve` - Headless HTTP server
- `opencode web` - Headless server with web UI
- `--format` - Output format: `"default"` or `"json"`

**HTTP API** (`opencode serve --port 4096`):

**Key endpoints:**
- `POST /session` - Create session
- `POST /session/:id/message` - Send message (blocking)
- `POST /session/:id/prompt_async` - Send asynchronously
- `GET /session/:id/event` - SSE event stream
- `POST /session/:id/abort` - Abort running session

**Event schemas (SSE):**
- `message.updated` - Message content changed
- `message.part.updated` - Part updated
- `message.part.delta` - Streaming text delta

**SDK** (`@opencode-ai/sdk`):
```typescript
import { createOpencode } from "@opencode-ai/sdk";

const { client } = await createOpencode({
  port: 4096,
  config: { model: "..." }
});

await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: "Your prompt" }],
    format: { type: "json_schema", schema: {} }
  }
});
```

**Capabilities:**
- HTTP API with OpenAPI spec
- Async and blocking message patterns
- Session forking and reverting
- Structured output with JSON Schema
- Server-sent events for real-time updates

**Limitations:**
- Sessions hang with Task tool spawning subagents (documented issue #6573)
- Default port 4096

### Comparison Matrix

| Feature | Claude Code | Codex CLI | Pi | OpenCode |
|---------|-------------|-----------|-----|----------|
| **Primary flag** | `-p` | `exec --json` | `--mode rpc` | `serve` + HTTP API |
| **Output format** | JSON, stream-json | JSONL | JSON-RPC | JSON (SSE events) |
| **SDK available** | Yes (TS/Python) | No | Yes (TS/JS) | Yes (TS/JS) |
| **Event streaming** | Yes | Yes | Yes | Yes (SSE) |
| **Session mgmt** | CLI flags | CLI flags | RPC commands | HTTP API |
| **JSON Schema** | `--json-schema` | `--output-schema` | Not documented | `format` param |
| **MCP support** | Yes | Yes | No (extensions) | Yes |

**Key finding:** All agents support programmatic modes, but none have perfectly complete documentation. Some reverse engineering required.

---

## 3. tmux Programmatic Control

### Session Creation & Management

**Core Commands:**
```bash
tmux new-session -s <name>
tmux new-window -t <session>:<index>
tmux split-window -t <target>
tmux list-sessions / list-windows / list-panes
```

**Programmatic Libraries:**
- **[libtmux](https://libtmux.git-pull.com/)** (Python) - Typed API with Server/Session/Window/Pane objects
- **JavaScript/TypeScript** - No mature native library; implementations shell out to tmux CLI

### Sending Input to Panes

**send-keys command:**
```bash
tmux send-keys -t session:window.pane 'command text' Enter
```

**Special keys**: `C-c`, `M-x`, `Up`, `Down`, `Enter`, `Escape`, `F1-F12`, etc.

### Capturing Output from Panes

**capture-pane command:**
```bash
tmux capture-pane -t <target> -p           # To stdout
tmux capture-pane -t <target> -p -S -100   # Last 100 lines
```

**Streaming capture with pipe-pane:**
```bash
tmux pipe-pane -t <target> 'cat >> /path/to/logfile'
```

### Detecting Agent State

**AMBIGUOUS**: No standard way to detect "agent idle" vs "agent working"

**Method 1: Format Variables**
```bash
tmux display-message -p -t <pane> '#{pane_dead}'
tmux display-message -p -t <pane> '#{pane_current_command}'
tmux display-message -p -t <pane> '#{pane_pid}'
```

**Useful format variables:**
- `#{pane_dead}` - 1 if pane is dead
- `#{pane_dead_status}` - Exit code (requires `remain-on-exit`)
- `#{pane_current_command}` - Currently running command
- `#{pane_pid}` - Process ID

**Method 2: remain-on-exit Option**
```bash
tmux set-option -g remain-on-exit on
```
Keeps panes open after process exits, allowing exit code checking.

**Method 3: tmux Hooks (Limited)**
- `pane-exited` - Fires when pane process exits (buggy)
- No hook for detecting when prompt returns (idle detection)
- **Hooks are "clunky"** for fine-grained pane monitoring

**Method 4: Polling Output (Common Pattern)**
```bash
tmux capture-pane -t <pane> -p | tail -n 1
```
Check if content ends with expected prompt pattern.

**RECOMMENDATION**: Use marker injection for reliability:
```typescript
ptyProcess.write("my-command; echo '__DONE_MARKER_12345__'\n");
```

### tmux Control Mode (-C)

**What it is:**
- Special protocol for programmatic interaction
- Text-based, easily parseable
- Commands on stdin, responses on stdout
- Structured format with `%begin` ... `%end` blocks

**Protocol structure:**
```
%begin <timestamp> <command-sequence-number>
<output lines>
%end <timestamp> <command-sequence-number>
```

**Notifications:**
- `%session-changed`
- `%window-add`, `%window-close`
- `%output <pane-id> <data>` - Pane output

**CLEAR**: Control mode exists and is well-documented.

**AMBIGUOUS**: Limited adoption - few libraries/examples. Most tools shell out to tmux CLI instead.

### Full tmux API

**Session management**: `new-session`, `kill-session`, `attach-session`, `detach-client`
**Window management**: `new-window`, `kill-window`, `rename-window`, `select-window`
**Pane management**: `split-window`, `kill-pane`, `resize-pane`, `respawn-pane`
**Output/Input**: `send-keys`, `capture-pane`, `pipe-pane`, `paste-buffer`
**Introspection**: `list-*`, `display-message`, `show-options`, `show-environment`
**Hooks**: `set-hook`, `show-hooks`

**CLEAR**: Full API documented in man page. Most commands support `-F` format strings for structured output.

---

## 4. Bun + TypeScript Specifics

### PTY Handling in Bun

**IMPORTANT**: `node-pty` does NOT work with Bun.

**Use instead:**

1. **[@sursaone/bun-pty](https://github.com/sursaone/bun-pty)** (Recommended)
   - Cross-platform PTY for Bun runtime
   - Uses Rust's `portable-pty` + Bun FFI
   - Full TypeScript definitions

```typescript
import { spawn } from "bun-pty";

const ptyProcess = spawn({
  command: "bash",
  args: [],
  cwd: process.cwd(),
  env: process.env,
  cols: 80,
  rows: 24,
});

ptyProcess.onData((data: string) => {
  console.log("Output:", data);
});

ptyProcess.write("echo hello\n");
```

2. **Native Bun PTY support**:
```typescript
import { spawn } from "bun";

const proc = spawn({
  cmd: ["python", "interactive.py"],
  terminal: true,  // Attach PTY
  stdout: "pipe",
  stdin: "pipe",
});
```

**CLEAR**: Use `bun-pty` packages or Bun's native `terminal` option.

### Child Process Management in Bun

**Bun.spawn() API:**
```typescript
import { spawn } from "bun";

const proc = spawn(["echo", "hello"], {
  cwd: "/tmp",
  env: { ...process.env, CUSTOM: "value" },
  onExit(proc, exitCode, signalCode, error) {
    console.log("Exited:", exitCode);
  },
});

await proc.exited; // Returns exit code
proc.kill();       // SIGTERM
```

**Stream configuration:**
```typescript
const proc = spawn(["cat"], {
  stdin: "pipe",   // WritableStream
  stdout: "pipe",  // ReadableStream
  stderr: "pipe",  // ReadableStream
});

const text = await proc.stdout.text();
```

**Performance**: Uses `posix_spawn(3)`, 60% faster than Node.js `child_process`

**CLEAR**: Bun has comprehensive, well-documented child process API.

### HTTP Server (Hono Framework)

**Why Hono:**
- Lightweight (~14 KB minified)
- Zero dependencies
- Built on Web Standards
- First-class Bun + TypeScript support

**Basic setup:**
```typescript
import { Hono } from "hono";
import { serve } from "bun";

const app = new Hono();

app.get("/", (c) => c.text("Hello Hono!"));
app.post("/data", async (c) => {
  const body = await c.req.json();
  return c.json({ received: body });
});

serve({
  port: 3000,
  fetch: app.fetch,
});
```

**Middleware:**
```typescript
import { cors } from "hono/cors";
import { logger } from "hono/logger";

app.use("*", cors());
app.use("*", logger());
```

**CLEAR**: Hono is a mature, well-documented choice for Bun HTTP servers.

### SSE/WebSocket Streaming

**Server-Sent Events (SSE) with Hono:**
```typescript
import { streamSSE } from "hono/streaming";

app.get("/sse", (c) => {
  return streamSSE(c, async (stream) => {
    let id = 0;
    while (true) {
      await stream.writeSSE({
        data: JSON.stringify({ message: "Hello", id }),
        event: "message",
        id: String(id),
      });
      await stream.sleep(1000);
      id++;
      if (id > 10) break;
    }
  });
});
```

**WebSockets (Native Bun):**
```typescript
import { serve } from "bun";

serve({
  port: 3000,
  fetch(req, server) {
    if (req.url.endsWith("/ws")) {
      server.upgrade(req, {
        data: { userId: "123" },
      });
      return;
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      console.log("Connected:", ws.data.userId);
    },
    message(ws, message) {
      ws.send("Echo: " + message);
    },
    close(ws, code, reason) {
      console.log("Closed:", code, reason);
    },
  },
});
```

**RECOMMENDATION**: Use SSE for one-way streaming (agent output), WebSockets for bidirectional real-time.

### Structured Logging (Pino)

**Why Pino:**
- 5x faster than Winston
- JSON logging by default
- Asynchronous I/O
- Security features (redaction)

**Basic setup:**
```typescript
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
    },
  },
});

logger.info("Server started");
logger.error({ err: new Error("Oops") }, "Error occurred");
```

**Child loggers (context):**
```typescript
const requestLogger = logger.child({
  requestId: "abc123",
  userId: "user456",
});

requestLogger.info("Processing request");
```

**CLEAR**: Pino is the performance leader for Bun/TypeScript structured logging.

---

## 5. Prior Art Survey

### Every Code

**Repository**: [just-every/code](https://github.com/just-every/code)

**What it is**: Community fork of OpenAI's Codex CLI focused on multi-provider agent orchestration (OpenAI, Claude, Gemini).

**Key ideas:**
- **Multi-Agent Command Modes**: `/plan` (consensus), `/solve` (racing), `/code` (worktrees)
- **Racing architecture**: Fastest preferred agent wins
- **Bounded history with hard caps**: Prevents runaway state accumulation
- **Non-blocking background operations**: Auto Review doesn't block command flow
- **Browser integration via CDP**: Inline screenshots, headless mode
- **Dual authentication paths**: ChatGPT Plus sign-in OR API keys

**Worth borrowing:**
- Multi-provider consensus mechanisms
- Racing architecture for competitive execution
- Bounded history patterns
- Browser integration via Chrome DevTools Protocol

### Claude Code Agentrooms

**Repository**: [baryhuang/claude-code-by-agents](https://github.com/baryhuang/claude-code-by-agents)

**What it is**: Multi-agent development workspace for Claude CLI with specialized agent routing.

**Architecture**: Hub-and-spoke with @mention routing

```
Frontend → Main Backend (Orchestrator) → Local Agent 1 (localhost:8081)
                                      → Local Agent 2 (localhost:8082)
                                      → Remote Agent 3 (your-host.local:8081)
```

**Key ideas:**
- **@Mention routing**: `@agent-name` for direct routing
- **Dual execution modes**: Direct (with @mentions) vs Orchestrated (without)
- **Local + remote agents**: Coordinate agents across machines
- **File-based inter-agent communication**: Not message-passing
- **Single subscription billing**: All agents share one Claude account

**Worth borrowing:**
- @mention routing system for intuitive invocation
- File-based coordination pattern
- Mixed local/remote deployment
- Conditional orchestration

### Tide Commander

**Repository**: [deivid11/tide-commander](https://github.com/deivid11/tide-commander)

**What it is**: Visual multi-agent orchestrator with 3D battlefield-style interface for Claude Code and Codex.

**Architecture**: Three-layer (React + Three.js frontend, Node.js + Express backend, CLI integration)

**Key ideas:**
- **Gamified visualization**: Agents as 3D characters in RTS-style interface
- **Hierarchical agent roles**: Boss agents, supervisors, workers
- **Three visualization modes**: 3D battlefield, 2D canvas, dashboard
- **Skills system**: Extensible TypeScript capabilities
- **Buildings as infrastructure**: Databases/servers as interactive 3D objects
- **Session persistence**: Conversations resume across restarts
- **Real-time WebSocket streaming**: No polling
- **Mobile support**: Android app for remote control

**Worth borrowing:**
- Skills system for extensible capabilities
- Hierarchical orchestration patterns
- Session persistence mechanism
- Real-time WebSocket streaming
- Process-level integration (wraps actual CLI instances)
- Multi-provider CLI support

### Comparison Matrix

| Feature | Every Code | Agentrooms | Tide Commander |
|---------|-----------|------------|----------------|
| **Primary Focus** | Multi-provider consensus | Specialized routing | Visual orchestration |
| **Architecture** | CLI fork with racing | Hub-and-spoke | 3-tier with 3D viz |
| **Agent Communication** | Worktree-based | File-based | WebSocket real-time |
| **Routing** | Command modes | @mentions | Boss/supervisor |
| **Visualization** | Terminal TUI | Desktop app | 3D/2D/dashboard |
| **Multi-Provider** | Yes (3 models) | Claude-focused | Yes (2 CLIs) |
| **Remote Agents** | No | Yes | No |
| **Mobile** | No | No | Yes (Android) |

---

## 6. Key Findings & Recommendations

### What is Clear

1. **Provider abstraction works**: CAO demonstrates 6-method interface is sufficient
2. **Tmux is viable for orchestration**: Human-inspectable, well-documented API
3. **All agents support programmatic modes**: Claude Code, Codex, Pi, OpenCode all headless-capable
4. **Bun ecosystem is mature**: Hono, Pino, native spawn, bun-pty all production-ready
5. **Regex-based status detection is common**: No agent provides perfect state APIs
6. **Three orchestration patterns emerge**: Sync (handoff), async (assign), messaging (inbox)

### What is Ambiguous

1. **tmux state detection**: No standard idle detection; polling + heuristics required
2. **tmux Control Mode adoption**: Well-documented but rarely used in practice
3. **Detecting process completion in PTY**: Must use marker injection or heuristics
4. **Which bun-pty fork**: Multiple forks exist, unclear which is most maintained

### What is Missing

1. **Perfect agent state APIs**: All require regex parsing or polling
2. **Production-grade error recovery**: CAO lacks retry logic, timeout handling
3. **Agent lifecycle management**: Cleanup on crash not well-addressed
4. **Multi-user support**: All surveyed tools are localhost/single-user
5. **Standardized inter-agent protocol**: Each tool invents its own

### Recommended Architecture

**Core Stack:**
- **Runtime**: Bun
- **HTTP Server**: Hono
- **Logging**: Pino with structured JSON
- **Child Processes**: Bun.spawn() for most cases
- **PTY**: @sursaone/bun-pty or Bun's native `terminal: true`
- **Streaming**: SSE (via Hono streamSSE) for agent output, WebSockets for bidirectional
- **Session Management**: tmux via CLI (not Control Mode)

**Orchestration Patterns:**
1. **Provider abstraction**: 6-method interface like CAO
2. **Status detection**: Regex-based with provider-specific patterns
3. **State polling**: Poll tmux capture-pane, not hooks
4. **Marker injection**: For reliable command completion
5. **Inbox queuing**: For async message delivery
6. **Working directory inheritance**: Via tmux environment variables

**tmux Strategy:**
- Shell out to tmux CLI (don't use Control Mode)
- Use format strings for introspection: `tmux display-message -p '#{var}'`
- Poll for state changes (no reliable event-based system)
- Use `remain-on-exit on` if exit codes needed
- Inject marker text for command completion

**Agent Integration:**
- **Claude Code**: `-p --output-format stream-json`
- **Codex**: `exec --json`
- **Pi**: `--mode rpc`
- **OpenCode**: `serve` + HTTP client

**Features to Prioritize:**
1. Provider abstraction for easy agent addition
2. Regex-based status detection (idle/working/done/error)
3. Three orchestration modes (sync/async/messaging)
4. Session persistence
5. WebSocket streaming for real-time updates
6. Structured logging with request context

**Features to Defer:**
1. Authentication/multi-user (localhost-only initially)
2. 3D visualization (focus on functional API first)
3. Browser integration via CDP
4. Mobile support
5. Complex consensus/racing mechanisms

### Open Questions for Implementation

1. **Polling intervals**: How often to check agent status without excessive load?
2. **History limits**: How many lines to capture from tmux panes?
3. **Timeout strategy**: When to kill unresponsive agents?
4. **Database choice**: SQLite (like CAO) or in-memory for MVP?
5. **API surface**: REST-only or also native SDK?
6. **Agent discovery**: Static config or dynamic registration?

---

## Sources

### AWS CAO
- [GitHub: awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator)
- [AWS Blog: Introducing CLI Agent Orchestrator](https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/)

### Agent CLIs
- [Claude Code Headless Mode](https://code.claude.com/docs/en/headless)
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Codex Non-interactive Mode](https://developers.openai.com/codex/noninteractive/)
- [Codex JSON Event Cheatsheet](https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/)
- [Pi RPC Mode Documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)
- [OpenCode Server Documentation](https://opencode.ai/docs/server/)
- [OpenCode SDK Documentation](https://opencode.ai/docs/sdk/)

### tmux
- [libtmux documentation](https://libtmux.git-pull.com/)
- [tmux man page](https://man7.org/linux/man-pages/man1/tmux.1.html)
- [tmux Control Mode Wiki](https://github.com/tmux/tmux/wiki/Control-Mode)
- [tmux Formats Wiki](https://github.com/tmux/tmux/wiki/Formats)
- [Scripting tmux - Tao of tmux](https://tao-of-tmux.readthedocs.io/en/latest/manuscript/10-scripting.html)

### Bun + TypeScript
- [Bun spawn documentation](https://bun.com/docs/runtime/child-process)
- [bun-pty GitHub](https://github.com/sursaone/bun-pty)
- [Hono documentation](https://hono.dev/)
- [Hono Streaming Helper](https://hono.dev/docs/helpers/streaming)
- [Bun WebSockets](https://bun.com/docs/runtime/http/websockets)
- [Pino logger guide](https://signoz.io/guides/pino-logger/)

### Prior Art
- [GitHub: just-every/code](https://github.com/just-every/code)
- [GitHub: baryhuang/claude-code-by-agents](https://github.com/baryhuang/claude-code-by-agents)
- [GitHub: deivid11/tide-commander](https://github.com/deivid11/tide-commander)
- [Tide Commander - Medium](https://medium.com/@davidalcallvarez/tide-commander-visual-command-center-for-ai-coding-agents-ecd6d8612292)
