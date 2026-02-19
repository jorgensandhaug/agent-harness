# Agent ID and Naming Research

## Scope
Research and design only. No implementation changes in this document.

## 1) How agent IDs are generated (hex ID code)
- Agent IDs are generated in `src/types.ts:15`.
- `newAgentId()` allocates 4 random bytes with `crypto.getRandomValues`, then hex-encodes them to 8 lowercase hex chars.
- Code path:
  - `src/types.ts:15`
  - `src/session/manager.ts:715` calls `newAgentId()`.

## 2) How tmux window names are created (`codex-5650` style)
- Tmux window names are generated independently in `src/session/manager.ts:515`.
- `windowName(providerName)` uses `Math.random().toString(16).slice(2, 6)` and prefixes with provider, producing names like `codex-5650`.
- Tmux target is then `${project.tmuxSession}:${windowName}` in `src/session/manager.ts:803`.
- The window is created via `tmux new-window -n <name>` in `src/tmux/client.ts:238` and `src/tmux/client.ts:246`.
- Session-level auto-renaming is disabled on project/session creation (`allow-rename off`, `automatic-rename off`) in `src/tmux/client.ts:230`.

Why `codex-5650` differs from agent ID like `4883e17e`:
- They are two separate random values from different functions.
- Agent ID: crypto random, 8 hex chars.
- Window suffix: `Math.random()`-derived, 4 hex chars.

## 3) Full flow: create agent -> tmux window name -> callback payload
1. HTTP route accepts `POST /api/v1/projects/:name/agents` and validates body in `src/api/agents.ts:16`.
2. Route calls manager create in `src/api/agents.ts:71`.
3. Manager generates:
   - internal agent ID from `newAgentId()` at `src/session/manager.ts:715`
   - window name from `windowName(providerName)` at `src/session/manager.ts:716`
   - tmux target `${session}:${window}` at `src/session/manager.ts:803`
4. Manager creates tmux window with that name via `tmux.createWindow(...)` at `src/session/manager.ts:806`.
5. Manager stores agent record with all identifiers:
   - `id`
   - `windowName`
   - `tmuxTarget`
   in `src/session/manager.ts:822` and type shape in `src/session/types.ts:20`.
6. Poller reads each agent by stored `tmuxTarget`, derives status, and emits `status_changed` events with `agentId: agent.id` in `src/poller/poller.ts:335`.
7. Webhook client subscribes to `status_changed` in `src/webhook/client.ts:442`.
8. For terminal transitions, webhook payload is built in `src/webhook/client.ts:428`, including `agentId` from event/input (`src/webhook/client.ts:431`), then POSTed.
9. Receiver validates payload schema requiring `agentId` in `src/webhook-receiver.ts:12`.

## 4) Which identifier appears in webhook callbacks
- Webhook callbacks include `agentId` (the internal hex ID).
- Payload shape is defined in `src/webhook/client.ts:11`.
- No `windowName` or `tmuxTarget` is currently included in webhook payload.

## 5) Proposal: optional `name` in `POST /projects/:name/agents`
Goal: separate machine ID from human-readable name, and make tmux windows human-meaningful.

### API contract proposal
- Add optional `name` to request body for `POST /api/v1/projects/:name/agents`.
- If `name` is provided:
  - Use it as the tmux window name.
  - Store it as the agent’s human-readable identifier.
- Keep existing hex `id` field for internal identity and stable API references.

### Validation proposal for `name`
- Lowercase normalized.
- Allowed chars: `a-z`, `0-9`, `-`.
- Must start with `a-z`.
- Length: 3..40 chars.
- Reject reserved/ambiguous forms like `.` `..` and empty-after-normalization.

### Uniqueness proposal
- Uniqueness scope: within a project.
- Caller-provided name collision: return `409 NAME_CONFLICT` (do not silently mutate user input).
- Auto-generated name collision: retry generation; if still colliding, append `-2`, `-3`, etc.

### Data model and payload proposal
- Keep `id` as-is.
- Keep `windowName` for tmux compatibility.
- Add explicit `name` field (human-readable identifier) and set `windowName = name` for new agents.
- For callbacks, add optional `agentName` while keeping existing `agentId` for backward compatibility.

## 6) Auto-generated names when `name` is missing
Goal: readable aloud, typable in terminal, easy to distinguish.

### Recommended format
- `<provider>-<adjective>-<noun>`
- Example: `codex-bright-fox`

### Word-list design rules
- Short words (roughly 3..8 chars).
- Avoid hard-to-spell words and homophones.
- Avoid offensive terms.
- Use lowercase ASCII only.

### Uniqueness strategy
- Start with adjective+noun combinations (for example 256 x 256 = 65,536 base combinations per provider).
- Check uniqueness inside project before allocation.
- On collision, regenerate a few times.
- Final fallback: append numeric suffix (`-2`, `-3`, ...).

### Why better than hex-like suffixes
- Easier to read in tmux window lists.
- Easier to dictate verbally.
- Easier to type correctly in CLI operations.
- Maintains enough uniqueness for project-level scope.

## 7) Caller-provided names vs auto-generated names
### Caller-provided names are better when
- The caller already knows task intent (`cli-research`, `naming-investigator`).
- Humans need stable semantic labels across logs, screenshots, and incidents.
- Multi-agent orchestration benefits from explicit roles.

### Auto-generated names are better when
- Caller has no naming scheme.
- Quick ad-hoc creation is preferred.
- You want frictionless defaults and guaranteed terminal-safe formatting.

### Recommended policy
- Support both.
- Prefer caller-provided names when supplied and valid.
- Use readable auto-generated names otherwise.
- Always keep internal hex `id` for machine identity and non-ambiguous lookups.

## Suggested phased rollout (design only)
1. Add optional `name` input and validation.
2. Persist/display `name` on agent responses while preserving `id`.
3. Use `name` for tmux window naming on create.
4. Add optional `agentName` in webhook payload.
5. Keep `agentId` indefinitely for backward compatibility.

