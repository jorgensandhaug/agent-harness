import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { HarnessConfig } from "../config.ts";
import { createDebugTracker } from "../debug/tracker.ts";
import { createEventBus } from "../events/bus.ts";
import { createManager } from "../session/manager.ts";
import { createStore } from "../session/store.ts";
import { createApp } from "./app.ts";

const originalSpawn = Bun.spawn;

function makeConfig(): HarnessConfig {
	return {
		port: 0,
		tmuxPrefix: "ah-debug-route-test",
		logDir: "./logs",
		logLevel: "error",
		pollIntervalMs: 200,
		captureLines: 200,
		maxEventHistory: 1000,
		providers: {
			"claude-code": { command: "claude", extraArgs: [], env: {}, enabled: true },
			codex: { command: "codex", extraArgs: [], env: {}, enabled: true },
			pi: { command: "pi", extraArgs: [], env: {}, enabled: true },
			opencode: { command: "opencode", extraArgs: [], env: {}, enabled: true },
		},
	};
}

beforeEach(() => {
	(Bun as { spawn: typeof Bun.spawn }).spawn = ((cmd: readonly string[]) => {
		if (cmd[0] !== "tmux") {
			return originalSpawn(cmd as string[]);
		}
		return {
			exited: Promise.resolve(0),
			stdout: new Blob([""]).stream(),
			stderr: new Blob([""]).stream(),
		} as ReturnType<typeof Bun.spawn>;
	}) as typeof Bun.spawn;
});

afterEach(() => {
	(Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
});

describe("api/debug.route", () => {
	it("returns 404 for unknown agent", async () => {
		const config = makeConfig();
		const store = createStore();
		const eventBus = createEventBus(config.maxEventHistory);
		const debugTracker = createDebugTracker(config, eventBus);
		const manager = createManager(config, store, eventBus, debugTracker);
		const app = createApp(manager, store, eventBus, debugTracker, Date.now());

		const response = await app.fetch(
			new Request("http://localhost/api/v1/projects/p1/agents/agent-missing/debug"),
		);
		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error).toBe("AGENT_NOT_FOUND");
		debugTracker.stop();
	});
});
