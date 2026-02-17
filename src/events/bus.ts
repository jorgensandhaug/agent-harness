import { type EventId, eventIdCounter } from "../types.ts";
import type { EventFilter, NormalizedEvent } from "./types.ts";

type Subscriber = {
	filter: EventFilter;
	callback: (event: NormalizedEvent) => void;
};

function matchesFilter(event: NormalizedEvent, filter: EventFilter): boolean {
	if (filter.project && event.project !== filter.project) return false;
	if (filter.agentId && event.agentId !== filter.agentId) return false;
	if (filter.types && !filter.types.includes(event.type)) return false;
	return true;
}

export function createEventBus(maxHistory: number) {
	const history: NormalizedEvent[] = [];
	const subscribers: Subscriber[] = [];

	function emit(event: NormalizedEvent): void {
		history.push(event);
		// Trim history if over limit
		if (history.length > maxHistory) {
			history.splice(0, history.length - maxHistory);
		}
		// Notify subscribers
		for (const sub of subscribers) {
			if (matchesFilter(event, sub.filter)) {
				sub.callback(event);
			}
		}
	}

	function subscribe(filter: EventFilter, callback: (event: NormalizedEvent) => void): () => void {
		const sub: Subscriber = { filter, callback };
		subscribers.push(sub);
		return () => {
			const idx = subscribers.indexOf(sub);
			if (idx !== -1) subscribers.splice(idx, 1);
		};
	}

	function since(eventId: EventId, filter: EventFilter): readonly NormalizedEvent[] {
		const counter = eventIdCounter(eventId);
		return history.filter((e) => {
			if (eventIdCounter(e.id) <= counter) return false;
			return matchesFilter(e, filter);
		});
	}

	return { emit, subscribe, since };
}

export type EventBus = ReturnType<typeof createEventBus>;
