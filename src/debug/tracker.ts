import type { HarnessConfig } from "../config.ts";
import type { EventBus } from "../events/bus.ts";
import type { NormalizedEvent, StatusChangeSource } from "../events/types.ts";
import type { AgentStatus } from "../providers/types.ts";

const MAX_WARNINGS = 20;
const MAX_ERRORS = 100;
const MAX_TRANSITIONS = 100;

export type DebugErrorScope = "poll" | "capture" | "parse" | "tmux" | "api";

export type DebugError = {
	ts: string;
	scope: DebugErrorScope;
	message: string;
};

export type StatusTransition = {
	ts: string;
	from: AgentStatus;
	to: AgentStatus;
	source: StatusChangeSource | null;
};

export type AgentDebug = {
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
		lastParsedStatus: AgentStatus | null;
		lastProviderEventsCount: number;
		lastWarnings: readonly string[];
	};
	stream: {
		lastEventId: string | null;
		emittedCounts: Record<string, number>;
	};
	statusTransitions: readonly StatusTransition[];
	errors: readonly DebugError[];
};

type MutableAgentDebug = {
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
		lastParsedStatus: AgentStatus | null;
		lastProviderEventsCount: number;
		lastWarnings: string[];
	};
	stream: {
		lastEventId: string | null;
		emittedCounts: Record<string, number>;
	};
	statusTransitions: StatusTransition[];
	errors: DebugError[];
};

function newDebugState(config: HarnessConfig): MutableAgentDebug {
	return {
		poll: {
			lastPollAt: null,
			pollIntervalMs: config.pollIntervalMs,
			captureLines: config.captureLines,
			lastCaptureBytes: 0,
			lastDiffBytes: 0,
		},
		tmux: {
			paneDead: null,
			paneCurrentCommand: null,
		},
		parser: {
			lastParsedStatus: null,
			lastProviderEventsCount: 0,
			lastWarnings: [],
		},
		stream: {
			lastEventId: null,
			emittedCounts: {},
		},
		statusTransitions: [],
		errors: [],
	};
}

function toReadonly(state: MutableAgentDebug): AgentDebug {
	return {
		poll: { ...state.poll },
		tmux: { ...state.tmux },
		parser: {
			lastParsedStatus: state.parser.lastParsedStatus,
			lastProviderEventsCount: state.parser.lastProviderEventsCount,
			lastWarnings: [...state.parser.lastWarnings],
		},
		stream: {
			lastEventId: state.stream.lastEventId,
			emittedCounts: { ...state.stream.emittedCounts },
		},
		statusTransitions: [...state.statusTransitions],
		errors: [...state.errors],
	};
}

export function createDebugTracker(config: HarnessConfig, eventBus: EventBus) {
	const byAgentId = new Map<string, MutableAgentDebug>();

	function ensureAgent(agentId: string): MutableAgentDebug {
		let found = byAgentId.get(agentId);
		if (!found) {
			found = newDebugState(config);
			byAgentId.set(agentId, found);
		}
		return found;
	}

	function removeAgent(agentId: string): void {
		byAgentId.delete(agentId);
	}

	function notePoll(
		agentId: string,
		update: {
			lastPollAt?: string;
			lastCaptureBytes?: number;
			lastDiffBytes?: number;
		},
	): void {
		const state = ensureAgent(agentId);
		if (update.lastPollAt !== undefined) state.poll.lastPollAt = update.lastPollAt;
		if (update.lastCaptureBytes !== undefined)
			state.poll.lastCaptureBytes = update.lastCaptureBytes;
		if (update.lastDiffBytes !== undefined) state.poll.lastDiffBytes = update.lastDiffBytes;
	}

	function noteTmux(
		agentId: string,
		update: {
			paneDead?: boolean | null;
			paneCurrentCommand?: string | null;
		},
	): void {
		const state = ensureAgent(agentId);
		if (update.paneDead !== undefined) state.tmux.paneDead = update.paneDead;
		if (update.paneCurrentCommand !== undefined) {
			state.tmux.paneCurrentCommand = update.paneCurrentCommand;
		}
	}

	function noteParser(
		agentId: string,
		update: {
			lastParsedStatus?: AgentStatus;
			lastProviderEventsCount?: number;
			warningsToAppend?: readonly string[];
		},
	): void {
		const state = ensureAgent(agentId);
		if (update.lastParsedStatus !== undefined) {
			state.parser.lastParsedStatus = update.lastParsedStatus;
		}
		if (update.lastProviderEventsCount !== undefined) {
			state.parser.lastProviderEventsCount = update.lastProviderEventsCount;
		}
		if (update.warningsToAppend && update.warningsToAppend.length > 0) {
			state.parser.lastWarnings.push(...update.warningsToAppend);
			if (state.parser.lastWarnings.length > MAX_WARNINGS) {
				state.parser.lastWarnings.splice(0, state.parser.lastWarnings.length - MAX_WARNINGS);
			}
		}
	}

	function noteError(agentId: string, scope: DebugErrorScope, message: string): void {
		const state = ensureAgent(agentId);
		state.errors.push({ ts: new Date().toISOString(), scope, message });
		if (state.errors.length > MAX_ERRORS) {
			state.errors.splice(0, state.errors.length - MAX_ERRORS);
		}
	}

	function observeEvent(event: NormalizedEvent): void {
		const scopedAgentId = `${event.project}:${event.agentId}`;
		const state = ensureAgent(scopedAgentId);
		state.stream.lastEventId = event.id;
		state.stream.emittedCounts[event.type] = (state.stream.emittedCounts[event.type] ?? 0) + 1;

		if (event.type === "status_changed") {
			state.statusTransitions.push({
				ts: event.ts,
				from: event.from,
				to: event.to,
				source: event.source ?? null,
			});
			if (state.statusTransitions.length > MAX_TRANSITIONS) {
				state.statusTransitions.splice(0, state.statusTransitions.length - MAX_TRANSITIONS);
			}
		}
	}

	const unsubscribe = eventBus.subscribe({}, observeEvent);

	function getAgentDebug(agentId: string): AgentDebug | null {
		const state = byAgentId.get(agentId);
		if (!state) return null;
		return toReadonly(state);
	}

	function stop(): void {
		unsubscribe();
	}

	return {
		ensureAgent,
		removeAgent,
		notePoll,
		noteTmux,
		noteParser,
		noteError,
		getAgentDebug,
		stop,
	};
}

export type DebugTracker = ReturnType<typeof createDebugTracker>;
