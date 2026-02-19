import { AGENT_NAME_ADJECTIVES, AGENT_NAME_NOUNS } from "./agent-name-words.ts";

/** Branded type helper for nominal typing */
type Brand<T, B extends string> = T & { readonly __brand: B };

/** Branded ID types */
export type AgentId = Brand<string, "AgentId">;
export type ProjectName = Brand<string, "ProjectName">;
export type EventId = Brand<string, "EventId">;

const AGENT_ID_PATTERN = /^[a-z0-9-]{3,40}$/;
const MAX_PROVIDER_PREFIX_LENGTH = 22;
const AGENT_NAME_RETRY_LIMIT = 64;
const AUTO_SUFFIX_START = 2;

/** Create an AgentId from a string */
export function agentId(id: string): AgentId {
	return id as AgentId;
}

/** Validate a candidate agent ID */
export function isValidAgentId(value: string): value is AgentId {
	return AGENT_ID_PATTERN.test(value);
}

/** Normalize user input for agent ID/name validation */
export function normalizeAgentIdInput(value: string): string {
	return value.trim();
}

function normalizeProviderPrefix(providerName: string): string {
	const normalized = providerName
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	const compact = normalized.length > 0 ? normalized : "agent";
	const sliced = compact.slice(0, MAX_PROVIDER_PREFIX_LENGTH).replace(/-+$/g, "");
	return sliced.length > 0 ? sliced : "agent";
}

function randomIndex(maxExclusive: number): number {
	if (!Number.isFinite(maxExclusive) || maxExclusive <= 1) return 0;
	const raw = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
	return raw % maxExclusive;
}

/**
 * Generate a readable agent ID in the format `<provider>-<adjective>-<noun>`.
 * Falls back to numeric suffixes when collisions occur.
 */
export function newAgentId(
	providerName: string,
	takenInProject: ReadonlySet<string> = new Set<string>(),
): AgentId {
	const providerPrefix = normalizeProviderPrefix(providerName);
	const adjectives = AGENT_NAME_ADJECTIVES;
	const nouns = AGENT_NAME_NOUNS;

	for (let attempt = 0; attempt < AGENT_NAME_RETRY_LIMIT; attempt += 1) {
		const adjective = adjectives[randomIndex(adjectives.length)] ?? "quick";
		const noun = nouns[randomIndex(nouns.length)] ?? "otter";
		const candidate = `${providerPrefix}-${adjective}-${noun}`;
		if (!takenInProject.has(candidate) && isValidAgentId(candidate)) {
			return candidate as AgentId;
		}
	}

	const fallbackBase = `${providerPrefix}-${adjectives[0] ?? "quick"}-${nouns[0] ?? "otter"}`;
	for (let suffix = AUTO_SUFFIX_START; suffix < 10000; suffix += 1) {
		const suffixPart = `-${suffix}`;
		const maxBaseLen = 40 - suffixPart.length;
		const base = fallbackBase.slice(0, maxBaseLen).replace(/-+$/g, "");
		const candidate = `${base}${suffixPart}`;
		if (!takenInProject.has(candidate) && isValidAgentId(candidate)) {
			return candidate as AgentId;
		}
	}

	throw new Error("failed to generate a unique agent ID");
}

/** Create a ProjectName from a string */
export function projectName(name: string): ProjectName {
	return name as ProjectName;
}

/** Generate a monotonic EventId */
let eventCounter = 0;
export function newEventId(): EventId {
	eventCounter++;
	return `evt-${eventCounter}` as EventId;
}

/** Validate an event ID string has the expected format */
export function isValidEventId(id: string): id is EventId {
	return /^evt-\d+$/.test(id);
}

/** Parse an EventId to extract the counter value. Returns null for invalid IDs. */
export function eventIdCounter(id: EventId): number | null {
	const match = id.match(/^evt-(\d+)$/);
	if (!match?.[1]) return null;
	return Number.parseInt(match[1], 10);
}

/** Result type for operations that can fail */
export type Result<T, E> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
	return { ok: false, error };
}
