import { describe, expect, it } from "bun:test";
import type { HarnessConfig } from "../config.ts";
import { createDebugTracker } from "../debug/tracker.ts";
import { createEventBus } from "../events/bus.ts";
import { createManager } from "../session/manager.ts";
import { createStore } from "../session/store.ts";
import { createApp } from "./app.ts";

function makeConfig(): HarnessConfig {
	return {
		port: 0,
		tmuxPrefix: "ah-inspect-test",
		logDir: "./logs",
		logLevel: "error",
		pollIntervalMs: 200,
		captureLines: 200,
		maxEventHistory: 1000,
		subscriptions: {},
		providers: {
			"claude-code": { command: "claude", extraArgs: [], env: {}, enabled: true },
			codex: { command: "codex", extraArgs: [], env: {}, enabled: true },
			pi: { command: "pi", extraArgs: [], env: {}, enabled: true },
			opencode: { command: "opencode", extraArgs: [], env: {}, enabled: true },
		},
	};
}

describe("api/inspect.route", () => {
	it("serves inspector page", async () => {
		const config = makeConfig();
		const store = createStore();
		const eventBus = createEventBus(config.maxEventHistory);
		const debugTracker = createDebugTracker(config, eventBus);
		const manager = createManager(config, store, eventBus, debugTracker);
		const app = createApp(manager, store, eventBus, debugTracker, Date.now());

		const response = await app.fetch(new Request("http://localhost/inspect"));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");

		const html = await response.text();
		expect(html).toContain("Agent Harness Inspector");
		expect(html).toContain("Copy attach");
		expect(html).toContain("Connect Existing");
		expect(html).toContain("Status source");
		expect(html).toContain("Subscription (optional)");
		expect(html).toContain("Internals messages");
		expect(html).toContain("Last assistant message (internals)");
		expect(html).toContain("/messages?limit=");
		expect(html).toContain("/messages/last");
		expect(html).toContain("/api/v1/projects");
		debugTracker.stop();
	});
});
