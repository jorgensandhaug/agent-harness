import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentId, ProjectName } from "../types.ts";
import type { AgentCallback } from "./types.ts";

type CallbackStateFile = {
	version: 1;
	projects: Record<string, AgentCallback>;
	agents: Record<string, AgentCallback>;
};

type RawCallback = {
	url?: unknown;
	token?: unknown;
	discordChannel?: unknown;
	sessionKey?: unknown;
	extra?: unknown;
};

type RawState = {
	version?: unknown;
	projects?: unknown;
	agents?: unknown;
};

function emptyState(): CallbackStateFile {
	return {
		version: 1,
		projects: {},
		agents: {},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!isRecord(value)) return false;
	return Object.values(value).every((entry) => typeof entry === "string");
}

function parseCallback(value: unknown): AgentCallback | null {
	if (!isRecord(value)) return null;
	const raw: RawCallback = value;
	if (typeof raw.url !== "string" || raw.url.trim().length === 0) return null;
	if (raw.token !== undefined && typeof raw.token !== "string") return null;
	if (raw.discordChannel !== undefined && typeof raw.discordChannel !== "string") return null;
	if (raw.sessionKey !== undefined && typeof raw.sessionKey !== "string") return null;
	if (raw.extra !== undefined && !isStringRecord(raw.extra)) return null;
	return {
		url: raw.url,
		...(typeof raw.token === "string" ? { token: raw.token } : {}),
		...(typeof raw.discordChannel === "string" ? { discordChannel: raw.discordChannel } : {}),
		...(typeof raw.sessionKey === "string" ? { sessionKey: raw.sessionKey } : {}),
		...(isStringRecord(raw.extra) ? { extra: raw.extra } : {}),
	};
}

function parseState(raw: unknown): CallbackStateFile {
	if (!isRecord(raw)) return emptyState();
	const parsed: RawState = raw;
	if (parsed.version !== 1) return emptyState();
	const rawProjects = isRecord(parsed.projects) ? parsed.projects : {};
	const rawAgents = isRecord(parsed.agents) ? parsed.agents : {};
	const projects: Record<string, AgentCallback> = {};
	const agents: Record<string, AgentCallback> = {};

	for (const [key, value] of Object.entries(rawProjects)) {
		const parsed = parseCallback(value);
		if (parsed) projects[key] = parsed;
	}
	for (const [key, value] of Object.entries(rawAgents)) {
		const parsed = parseCallback(value);
		if (parsed) agents[key] = parsed;
	}

	return { version: 1, projects, agents };
}

function cloneCallback(callback: AgentCallback): AgentCallback {
	return {
		url: callback.url,
		...(callback.token ? { token: callback.token } : {}),
		...(callback.discordChannel ? { discordChannel: callback.discordChannel } : {}),
		...(callback.sessionKey ? { sessionKey: callback.sessionKey } : {}),
		...(callback.extra ? { extra: { ...callback.extra } } : {}),
	};
}

function normalizeCallback(callback: AgentCallback | undefined): AgentCallback | undefined {
	if (!callback) return undefined;
	const url = callback.url.trim();
	if (url.length === 0) return undefined;
	const token = callback.token?.trim();
	const discordChannel = callback.discordChannel?.trim();
	const sessionKey = callback.sessionKey?.trim();
	const extra = callback.extra ? Object.fromEntries(Object.entries(callback.extra)) : undefined;
	return {
		url,
		...(token ? { token } : {}),
		...(discordChannel ? { discordChannel } : {}),
		...(sessionKey ? { sessionKey } : {}),
		...(extra ? { extra } : {}),
	};
}

function callbacksEqual(a: AgentCallback | undefined, b: AgentCallback | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function agentKey(project: ProjectName, id: AgentId): string {
	return `${project}:${id}`;
}

export function createCallbackState(logDir: string) {
	const statePath = resolve(logDir, "state", "callbacks.json");
	let loaded = false;
	let state: CallbackStateFile = emptyState();
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

	async function getProjectCallback(project: ProjectName): Promise<AgentCallback | undefined> {
		await ensureLoaded();
		const found = state.projects[project];
		return found ? cloneCallback(found) : undefined;
	}

	async function getAgentCallback(
		project: ProjectName,
		id: AgentId,
	): Promise<AgentCallback | undefined> {
		await ensureLoaded();
		const found = state.agents[agentKey(project, id)];
		return found ? cloneCallback(found) : undefined;
	}

	async function setProjectCallback(
		project: ProjectName,
		callback: AgentCallback | undefined,
	): Promise<void> {
		await ensureLoaded();
		const next = normalizeCallback(callback);
		const current = state.projects[project];
		if (callbacksEqual(current, next)) return;
		if (next) {
			state.projects[project] = next;
		} else {
			delete state.projects[project];
		}
		await queueFlush();
	}

	async function setAgentCallback(
		project: ProjectName,
		id: AgentId,
		callback: AgentCallback | undefined,
	): Promise<void> {
		await ensureLoaded();
		const key = agentKey(project, id);
		const next = normalizeCallback(callback);
		const current = state.agents[key];
		if (callbacksEqual(current, next)) return;
		if (next) {
			state.agents[key] = next;
		} else {
			delete state.agents[key];
		}
		await queueFlush();
	}

	async function removeProject(project: ProjectName): Promise<void> {
		await ensureLoaded();
		let changed = false;
		if (state.projects[project]) {
			delete state.projects[project];
			changed = true;
		}
		const prefix = `${project}:`;
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

	async function prune(
		projects: ReadonlySet<ProjectName>,
		agents: ReadonlySet<string>,
	): Promise<void> {
		await ensureLoaded();
		let changed = false;
		for (const project of Object.keys(state.projects)) {
			if (projects.has(project as ProjectName)) continue;
			delete state.projects[project];
			changed = true;
		}
		for (const key of Object.keys(state.agents)) {
			if (agents.has(key)) continue;
			delete state.agents[key];
			changed = true;
		}
		if (changed) await queueFlush();
	}

	return {
		getProjectCallback,
		getAgentCallback,
		setProjectCallback,
		setAgentCallback,
		removeProject,
		removeAgent,
		prune,
	};
}

export type CallbackState = ReturnType<typeof createCallbackState>;
