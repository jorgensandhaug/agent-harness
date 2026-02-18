import { afterEach, describe, expect, it } from "bun:test";
import type { HarnessConfig } from "../config.ts";
import { createDebugTracker } from "../debug/tracker.ts";
import { createEventBus } from "../events/bus.ts";
import { createManager } from "../session/manager.ts";
import { createStore } from "../session/store.ts";
import type {
	WebhookClient,
	WebhookClientStatus,
	WebhookPayload,
	WebhookTestInput,
} from "../webhook/client.ts";
import { createApp } from "./app.ts";

const originalFetch = globalThis.fetch;

function makeConfig(): HarnessConfig {
	return {
		port: 0,
		tmuxPrefix: "ah-webhook-api-test",
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

function makeWebhookStatus(url = "http://receiver.test/harness-webhook"): WebhookClientStatus {
	return {
		enabled: true,
		startedAt: "2026-02-18T00:00:00.000Z",
		config: {
			url,
			tokenConfigured: true,
			events: ["agent_completed"],
			safetyNet: {
				enabled: true,
				intervalMs: 30000,
				stuckAfterMs: 180000,
				stuckWarnIntervalMs: 300000,
			},
			globalFallbackConfigured: true,
		},
		counters: {
			attempts: 3,
			successes: 2,
			failures: 1,
			retries: 1,
			manualTests: 0,
			safetyNetCycles: 10,
			safetyNetWarnings: 0,
		},
		lastAttemptAt: "2026-02-18T00:00:10.000Z",
		lastSuccessAt: "2026-02-18T00:00:09.000Z",
		lastFailureAt: "2026-02-18T00:00:08.000Z",
		lastSafetyNetWarningAt: null,
		trackedAgents: {
			lifecycle: 0,
			deliveredTerminal: 0,
			stuckWarned: 0,
		},
		recentAttempts: [],
	};
}

function makeFakeWebhookClient() {
	const calls: WebhookTestInput[] = [];
	const status = makeWebhookStatus();
	const client = (() => {}) as WebhookClient;
	client.getStatus = () => status;
	client.sendTestWebhook = async (input?: WebhookTestInput) => {
		calls.push(input ?? {});
		const payload: WebhookPayload = {
			event: input?.event ?? "agent_completed",
			project: input?.project ?? "__inspect_test__",
			agentId: input?.agentId ?? "__inspect_test__",
			provider: input?.provider ?? "inspect",
			status: input?.status ?? "idle",
			lastMessage: input?.lastMessage ?? "manual inspector webhook test",
			timestamp: "2026-02-18T00:00:20.000Z",
		};
		return { ok: true, payload };
	};
	return { client, calls };
}

afterEach(() => {
	(globalThis as { fetch: typeof fetch }).fetch = originalFetch;
});

describe("api/webhook.routes", () => {
	it("returns configured webhook status + executes manual test", async () => {
		const config = makeConfig();
		const store = createStore();
		const eventBus = createEventBus(config.maxEventHistory);
		const debugTracker = createDebugTracker(config, eventBus);
		const manager = createManager(config, store, eventBus, debugTracker);
		const fake = makeFakeWebhookClient();
		const app = createApp(
			manager,
			store,
			eventBus,
			debugTracker,
			Date.now(),
			undefined,
			fake.client,
		);

		const statusResponse = await app.fetch(new Request("http://localhost/api/v1/webhook/status"));
		expect(statusResponse.status).toBe(200);
		const statusJson = await statusResponse.json();
		expect(statusJson.configured).toBe(true);
		expect(statusJson.status.config.url).toBe("http://receiver.test/harness-webhook");

		const testResponse = await app.fetch(
			new Request("http://localhost/api/v1/webhook/test", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					project: "proj-a",
					agentId: "agent-a",
					provider: "codex",
					status: "idle",
					lastMessage: "hello",
				}),
			}),
		);
		expect(testResponse.status).toBe(200);
		const testJson = await testResponse.json();
		expect(testJson.ok).toBe(true);
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]).toEqual({
			event: undefined,
			project: "proj-a",
			agentId: "agent-a",
			provider: "codex",
			status: "idle",
			lastMessage: "hello",
		});

		debugTracker.stop();
	});

	it("probes receiver health + harness webhook endpoint", async () => {
		const config = makeConfig();
		const store = createStore();
		const eventBus = createEventBus(config.maxEventHistory);
		const debugTracker = createDebugTracker(config, eventBus);
		const manager = createManager(config, store, eventBus, debugTracker);
		const fake = makeFakeWebhookClient();
		const app = createApp(
			manager,
			store,
			eventBus,
			debugTracker,
			Date.now(),
			undefined,
			fake.client,
		);

		(globalThis as { fetch: typeof fetch }).fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			if (request.url === "http://receiver.test/health") {
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			if (request.url === "http://receiver.test/harness-webhook") {
				return new Response(JSON.stringify({ error: "invalid_payload" }), { status: 400 });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const response = await app.fetch(
			new Request("http://localhost/api/v1/webhook/probe-receiver", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}),
		);
		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.baseUrl).toBe("http://receiver.test");
		expect(json.health.status).toBe(200);
		expect(json.harnessWebhook.status).toBe(400);

		debugTracker.stop();
	});
});
