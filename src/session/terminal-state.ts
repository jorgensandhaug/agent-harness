import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentId, ProjectName } from "../types.ts";
import type {
	Agent,
	AgentTerminalDeliveryState,
	AgentTerminalMessageSource,
	AgentTerminalState,
	AgentTerminalStatus,
} from "./types.ts";

export type PersistedTerminalState = AgentTerminalState;

type TerminalStateFile = {
	version: 1;
	agents: Record<string, AgentTerminalState>;
};

type RawState = {
	version?: unknown;
	agents?: unknown;
};

const TERMINAL_STATUSES = new Set<AgentTerminalStatus>(["idle", "error", "exited"]);
const DELIVERY_STATES = new Set<AgentTerminalDeliveryState>(["pending", "sent", "not_applicable"]);
const FINAL_MESSAGE_SOURCES = new Set<AgentTerminalMessageSource | null>([
	null,
	"manager_initial_input",
	"manager_followup_input",
	"poller_pane_dead",
	"poller_session_not_found",
	"ui_parser",
	"internals_codex_jsonl",
	"internals_claude_jsonl",
	"internals_pi_jsonl",
	"internals_opencode_storage",
	"fallback_heuristic",
	"internals_unavailable",
]);

function agentKey(project: ProjectName, id: AgentId): string {
	return `${project}:${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nullableString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function emptyAgentTerminalState(): AgentTerminalState {
	return {
		pollState: "active",
		terminalStatus: null,
		terminalObservedAt: null,
		terminalQuietSince: null,
		finalizedAt: null,
		finalMessage: null,
		finalMessageSource: null,
		deliveryState: "not_applicable",
		deliveryInFlight: false,
		deliveryId: null,
		deliverySentAt: null,
	};
}

export function cloneAgentTerminalState(state: AgentTerminalState): AgentTerminalState {
	return { ...state };
}

export function normalizeAgentTerminalState(
	state: Partial<AgentTerminalState> | null | undefined,
): AgentTerminalState {
	const base = emptyAgentTerminalState();
	if (!state) return base;
	const terminalStatus = TERMINAL_STATUSES.has(state.terminalStatus as AgentTerminalStatus)
		? (state.terminalStatus as AgentTerminalStatus)
		: null;
	const deliveryState = DELIVERY_STATES.has(state.deliveryState as AgentTerminalDeliveryState)
		? (state.deliveryState as AgentTerminalDeliveryState)
		: base.deliveryState;
	const pollState =
		state.pollState === "finalizing" || state.pollState === "quiesced" ? state.pollState : "active";
	const finalMessageSource = FINAL_MESSAGE_SOURCES.has(
		(state.finalMessageSource ?? null) as AgentTerminalMessageSource | null,
	)
		? ((state.finalMessageSource ?? null) as AgentTerminalMessageSource | null)
		: null;
	const normalized = {
		pollState,
		terminalStatus,
		terminalObservedAt: nullableString(state.terminalObservedAt),
		terminalQuietSince: nullableString(state.terminalQuietSince),
		finalizedAt: nullableString(state.finalizedAt),
		finalMessage: typeof state.finalMessage === "string" ? state.finalMessage : null,
		finalMessageSource,
		deliveryState,
		deliveryInFlight: state.deliveryInFlight === true,
		deliveryId: nullableString(state.deliveryId),
		deliverySentAt: nullableString(state.deliverySentAt),
	} satisfies AgentTerminalState;

	// Pending in-flight work cannot survive a restart; release it so retries can resume.
	if (normalized.deliveryState !== "sent") {
		normalized.deliveryInFlight = false;
	}
	return normalized.pollState === "active" ? base : normalized;
}

export function terminalStateFromAgent(agent: Agent): AgentTerminalState {
	return normalizeAgentTerminalState({
		pollState: agent.pollState,
		terminalStatus: agent.terminalStatus,
		terminalObservedAt: agent.terminalObservedAt,
		terminalQuietSince: agent.terminalQuietSince,
		finalizedAt: agent.finalizedAt,
		finalMessage: agent.finalMessage,
		finalMessageSource: agent.finalMessageSource,
		deliveryState: agent.deliveryState,
		deliveryInFlight: agent.deliveryInFlight,
		deliveryId: agent.deliveryId,
		deliverySentAt: agent.deliverySentAt,
	});
}

export function defaultTerminalState(): AgentTerminalState {
	return emptyAgentTerminalState();
}

export function normalizeRecoveredTerminalState(
	state: PersistedTerminalState,
): PersistedTerminalState {
	return normalizeAgentTerminalState(state);
}

export function applyTerminalState(
	agent: Agent,
	state: Partial<AgentTerminalState> | null | undefined = defaultTerminalState(),
): Agent {
	const next = normalizeAgentTerminalState(state);
	agent.pollState = next.pollState;
	agent.terminalStatus = next.terminalStatus;
	agent.terminalObservedAt = next.terminalObservedAt;
	agent.terminalQuietSince = next.terminalQuietSince;
	agent.finalizedAt = next.finalizedAt;
	agent.finalMessage = next.finalMessage;
	agent.finalMessageSource = next.finalMessageSource;
	agent.deliveryState = next.deliveryState;
	agent.deliveryInFlight = next.deliveryInFlight;
	agent.deliveryId = next.deliveryId;
	agent.deliverySentAt = next.deliverySentAt;
	return agent;
}

export function clearTerminalState(agent: Agent): Agent {
	return applyTerminalState(agent, defaultTerminalState());
}

function isDefaultTerminalState(state: AgentTerminalState): boolean {
	return JSON.stringify(state) === JSON.stringify(emptyAgentTerminalState());
}

function emptyState(): TerminalStateFile {
	return {
		version: 1,
		agents: {},
	};
}

function parseTerminalState(value: unknown): AgentTerminalState | null {
	if (!isRecord(value)) return null;
	return normalizeAgentTerminalState(value as Partial<AgentTerminalState>);
}

function parseState(raw: unknown): TerminalStateFile {
	if (!isRecord(raw)) return emptyState();
	const parsed = raw as RawState;
	if (parsed.version !== 1) return emptyState();
	const rawAgents = isRecord(parsed.agents) ? parsed.agents : {};
	const agents: Record<string, AgentTerminalState> = {};
	for (const [key, value] of Object.entries(rawAgents)) {
		const parsedState = parseTerminalState(value);
		if (parsedState && !isDefaultTerminalState(parsedState)) {
			agents[key] = parsedState;
		}
	}
	return {
		version: 1,
		agents,
	};
}

export function createTerminalState(logDir: string) {
	const statePath = resolve(logDir, "state", "terminal.json");
	let loaded = false;
	let state: TerminalStateFile = emptyState();
	let flushChain = Promise.resolve();

	async function ensureLoaded(): Promise<void> {
		if (loaded) return;
		loaded = true;
		try {
			const text = await readFile(statePath, "utf8");
			state = parseState(JSON.parse(text));
		} catch {
			state = emptyState();
		}
	}

	async function flush(): Promise<void> {
		await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
		try {
			await chmod(dirname(statePath), 0o700);
		} catch {
			// best effort
		}
		const tempPath = `${statePath}.tmp.${process.pid}.${Date.now()}`;
		await writeFile(tempPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
		await rename(tempPath, statePath);
		try {
			await chmod(statePath, 0o600);
		} catch {
			// best effort
		}
	}

	function queueFlush(): Promise<void> {
		flushChain = flushChain.catch(() => undefined).then(flush);
		return flushChain;
	}

	async function getAgentState(
		project: ProjectName,
		id: AgentId,
	): Promise<AgentTerminalState | undefined> {
		await ensureLoaded();
		const found = state.agents[agentKey(project, id)];
		return found ? cloneAgentTerminalState(found) : undefined;
	}

	async function setAgentState(
		project: ProjectName,
		id: AgentId,
		next: AgentTerminalState,
	): Promise<void> {
		await ensureLoaded();
		const key = agentKey(project, id);
		const normalized = normalizeAgentTerminalState(next);
		const current = state.agents[key];
		if (isDefaultTerminalState(normalized)) {
			if (!current) return;
			delete state.agents[key];
			await queueFlush();
			return;
		}
		if (current && JSON.stringify(current) === JSON.stringify(normalized)) return;
		state.agents[key] = normalized;
		await queueFlush();
	}

	async function removeProject(project: ProjectName): Promise<void> {
		await ensureLoaded();
		const prefix = `${project}:`;
		let changed = false;
		for (const key of Object.keys(state.agents)) {
			if (!key.startsWith(prefix)) continue;
			delete state.agents[key];
			changed = true;
		}
		if (changed) await queueFlush();
	}

	async function removeAgent(project: ProjectName, id: AgentId): Promise<void> {
		await ensureLoaded();
		const key = agentKey(project, id);
		if (!state.agents[key]) return;
		delete state.agents[key];
		await queueFlush();
	}

	async function prune(agents: ReadonlySet<string>): Promise<void> {
		await ensureLoaded();
		let changed = false;
		for (const key of Object.keys(state.agents)) {
			if (agents.has(key)) continue;
			delete state.agents[key];
			changed = true;
		}
		if (changed) await queueFlush();
	}

	return {
		getAgentState,
		setAgentState,
		removeProject,
		removeAgent,
		prune,
	};
}

export type TerminalState = ReturnType<typeof createTerminalState>;
