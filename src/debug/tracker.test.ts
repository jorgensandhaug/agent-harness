import { describe, expect, it } from "bun:test";
import type { HarnessConfig } from "../config.ts";
import { createEventBus } from "../events/bus.ts";
import { newEventId } from "../types.ts";
import { createDebugTracker } from "./tracker.ts";

function makeConfig(): HarnessConfig {
	return {
		port: 0,
		tmuxPrefix: "ah-debug-test",
		logDir: "./logs",
		logLevel: "error",
		pollIntervalMs: 250,
		captureLines: 300,
		maxEventHistory: 1000,
		providers: {
			"claude-code": { command: "claude", extraArgs: [], env: {}, enabled: true },
			codex: { command: "codex", extraArgs: [], env: {}, enabled: true },
			pi: { command: "pi", extraArgs: [], env: {}, enabled: true },
			opencode: { command: "opencode", extraArgs: [], env: {}, enabled: true },
		},
	};
}

describe("debug/tracker", () => {
	it("tracks poll/tmux/parser/event/error state per agent", () => {
		const config = makeConfig();
		const eventBus = createEventBus(200);
		const tracker = createDebugTracker(config, eventBus);

		tracker.ensureAgent("a1");
		tracker.notePoll("a1", {
			lastPollAt: "2026-02-17T00:00:00.000Z",
			lastCaptureBytes: 128,
			lastDiffBytes: 16,
		});
		tracker.noteTmux("a1", { paneDead: false, paneCurrentCommand: "claude" });
		tracker.noteParser("a1", {
			lastParsedStatus: "processing",
			lastProviderEventsCount: 2,
			warningsToAppend: ["unparsed token"],
		});
		tracker.noteError("a1", "parse", "bad token");

		eventBus.emit({
			id: newEventId(),
			ts: "2026-02-17T00:00:01.000Z",
			project: "p1",
			agentId: "a1",
			type: "status_changed",
			from: "starting",
			to: "processing",
			source: "internals_claude_jsonl",
		});
		eventBus.emit({
			id: newEventId(),
			ts: "2026-02-17T00:00:02.000Z",
			project: "p1",
			agentId: "a1",
			type: "output",
			text: "hello",
		});

		const debug = tracker.getAgentDebug("a1");
		expect(debug).not.toBeNull();
		if (!debug) throw new Error("debug missing");

		expect(debug.poll.pollIntervalMs).toBe(250);
		expect(debug.poll.captureLines).toBe(300);
		expect(debug.poll.lastCaptureBytes).toBe(128);
		expect(debug.poll.lastDiffBytes).toBe(16);
		expect(debug.tmux.paneDead).toBe(false);
		expect(debug.tmux.paneCurrentCommand).toBe("claude");
		expect(debug.parser.lastParsedStatus).toBe("processing");
		expect(debug.parser.lastProviderEventsCount).toBe(2);
		expect(debug.parser.lastWarnings).toContain("unparsed token");
		expect(debug.stream.emittedCounts.status_changed).toBe(1);
		expect(debug.stream.emittedCounts.output).toBe(1);
		expect(debug.statusTransitions.length).toBe(1);
		expect(debug.statusTransitions[0]?.source).toBe("internals_claude_jsonl");
		expect(debug.errors.length).toBe(1);

		tracker.removeAgent("a1");
		expect(tracker.getAgentDebug("a1")).toBeNull();
		tracker.stop();
	});
});
