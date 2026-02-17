/** Branded type helper for nominal typing */
type Brand<T, B extends string> = T & { readonly __brand: B };

/** Branded ID types */
export type AgentId = Brand<string, "AgentId">;
export type ProjectName = Brand<string, "ProjectName">;
export type EventId = Brand<string, "EventId">;

/** Create an AgentId from a string (8-char hex) */
export function agentId(id: string): AgentId {
	return id as AgentId;
}

/** Generate a random 8-char hex AgentId */
export function newAgentId(): AgentId {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hex as AgentId;
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
