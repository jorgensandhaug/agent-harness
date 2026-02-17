import { describe, expect, it } from "bun:test";
import type { EventId } from "../types.ts";
import { createEventBus } from "./bus.ts";
import type { NormalizedEvent } from "./types.ts";

function evt(
	id: string,
	project: string,
	agentId: string,
	type: NormalizedEvent["type"],
): NormalizedEvent {
	const base = {
		id: id as EventId,
		ts: "2026-01-01T00:00:00.000Z",
		project,
		agentId,
	};

	switch (type) {
		case "output":
			return { ...base, type, text: "hello" };
		case "status_changed":
			return { ...base, type, from: "starting", to: "idle" };
		case "agent_started":
			return { ...base, type, provider: "codex" };
		case "tool_use":
			return { ...base, type, tool: "Read", input: "x" };
		case "tool_result":
			return { ...base, type, tool: "Read", output: "ok" };
		case "error":
			return { ...base, type, message: "bad" };
		case "agent_exited":
			return { ...base, type, exitCode: null };
		case "input_sent":
			return { ...base, type, text: "in" };
		case "permission_requested":
			return { ...base, type, description: "allow" };
		case "question_asked":
			return { ...base, type, question: "q?", options: ["y", "n"] };
		case "unknown":
			return { ...base, type, raw: "raw" };
	}
}

describe("events/bus.emit-subscribe-filter", () => {
	it("notifies only subscribers whose project/agent/type filters match", () => {
		const bus = createEventBus(100);
		const seen: string[] = [];

		bus.subscribe({ project: "p1", agentId: "a1", types: ["output"] }, (event) => {
			seen.push(event.id);
		});

		bus.emit(evt("evt-1", "p1", "a1", "output"));
		bus.emit(evt("evt-2", "p1", "a2", "output"));
		bus.emit(evt("evt-3", "p2", "a1", "output"));
		bus.emit(evt("evt-4", "p1", "a1", "error"));

		expect(seen).toEqual(["evt-1"]);
	});
});

describe("events/bus.since-replay", () => {
	it("replays strictly newer events with matching filters", () => {
		const bus = createEventBus(100);
		bus.emit(evt("evt-1", "p1", "a1", "output"));
		bus.emit(evt("evt-2", "p1", "a1", "error"));
		bus.emit(evt("evt-3", "p1", "a2", "output"));
		bus.emit(evt("evt-4", "p1", "a1", "output"));

		const replay = bus.since("evt-1" as EventId, { project: "p1", agentId: "a1", types: ["output"] });
		expect(replay.map((e) => e.id)).toEqual(["evt-4"]);
	});
});
