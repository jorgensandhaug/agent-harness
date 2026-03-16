import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig, WebhookConfig } from "../config.ts";
import { createEventBus } from "../events/bus.ts";
import { createManager } from "../session/manager.ts";
import { createStore } from "../session/store.ts";
import { applyTerminalState, createTerminalState } from "../session/terminal-state.ts";
import type { Agent } from "../session/types.ts";
import type { EventId } from "../types.ts";
import { agentId, projectName } from "../types.ts";
import { createWebhookClient } from "./client.ts";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(async () => {
	(globalThis as { fetch: typeof fetch }).fetch = originalFetch;
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
});

function makeConfig(logDir: string): HarnessConfig {
	return {
		port: 0,
		tmuxPrefix: "ah-webhook-test",
		logDir,
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

function baseAgent(runtimeDir?: string): Agent {
	const now = new Date().toISOString();
	return {
		id: agentId("abcd1234"),
		project: projectName("proj-1"),
		provider: "codex",
		status: "idle",
		brief: [],
		task: "test webhook",
		windowName: "codex-a1",
		tmuxTarget: "ah:codex-a1",
		attachCommand: "tmux attach -t ah",
		providerRuntimeDir: runtimeDir,
		createdAt: now,
		lastActivity: now,
		lastCapturedOutput: "",
		pollState: "active",
		terminalStatus: null,
		terminalObservedAt: null,
		terminalQuietSince: null,
		finalizedAt: null,
		finalMessage: null,
		finalMessageSource: null,
		deliveryState: "not_applicable",
		deliveryInFlight: false,
		deliveryId: null,
		deliverySentAt: null,
	};
}

function finalizedAgent(overrides: Partial<Agent> = {}, runtimeDir?: string): Agent {
	const observedAt = "2026-02-18T09:59:58.000Z";
	const finalizedAt = "2026-02-18T10:00:00.000Z";
	return {
		...baseAgent(runtimeDir),
		status: "idle",
		pollState: "quiesced",
		terminalStatus: "idle",
		terminalObservedAt: observedAt,
		terminalQuietSince: "2026-02-18T09:59:59.000Z",
		finalizedAt,
		deliveryState: "pending",
		deliveryInFlight: false,
		deliveryId: "delivery-1",
		deliverySentAt: null,
		...overrides,
	};
}

function emitTerminalFinalized(bus: ReturnType<typeof createEventBus>, agent: Agent): void {
	if (
		!agent.finalizedAt ||
		!agent.terminalObservedAt ||
		!agent.terminalStatus ||
		!agent.deliveryId
	) {
		throw new Error("agent missing finalized delivery fields");
	}
	bus.emit({
		id: "evt-finalized" as EventId,
		ts: agent.finalizedAt,
		project: agent.project,
		agentId: agent.id,
		type: "agent_terminal_finalized",
		provider: agent.provider,
		status: agent.terminalStatus,
		finalizedAt: agent.finalizedAt,
		terminalObservedAt: agent.terminalObservedAt,
		lastMessage: agent.finalMessage ?? null,
		messageSource: agent.finalMessageSource ?? null,
		deliveryId: agent.deliveryId,
	});
}

function createTestWebhookClient(
	config: WebhookConfig | null,
	store: ReturnType<typeof createStore>,
	bus: ReturnType<typeof createEventBus>,
	logDir = tempDirs[tempDirs.length - 1] ?? join(tmpdir(), "ah-webhook-client-default"),
) {
	const manager = createManager(makeConfig(logDir), store, bus);
	return createWebhookClient(config, bus, store, manager);
}

async function restoredAgentFromDisk(
	logDir: string,
	overrides: Partial<Agent> = {},
	runtimeDir?: string,
): Promise<Agent> {
	const persisted = await createTerminalState(logDir).getAgentState(
		projectName("proj-1"),
		agentId("abcd1234"),
	);
	const agent = finalizedAgent(overrides, runtimeDir);
	if (persisted) {
		applyTerminalState(agent, persisted);
	}
	return agent;
}

async function writeCodexSession(runtimeDir: string): Promise<void> {
	const dir = join(runtimeDir, "sessions", "2026", "02", "18");
	await mkdir(dir, { recursive: true });
	await Bun.write(
		join(dir, "rollout-2026-02-18T00-00-00.jsonl"),
		[
			JSON.stringify({
				timestamp: "2026-02-18T00:00:00.000Z",
				type: "event_msg",
				payload: { type: "user_message", message: "hello" },
			}),
			JSON.stringify({
				timestamp: "2026-02-18T00:00:01.000Z",
				type: "event_msg",
				payload: { type: "agent_message", message: "latest answer" },
			}),
		].join("\n"),
	);
}

async function writeCodexSessionWithPartialEventChunks(runtimeDir: string): Promise<void> {
	const dir = join(runtimeDir, "sessions", "2026", "02", "18");
	await mkdir(dir, { recursive: true });
	await Bun.write(
		join(dir, "rollout-2026-02-18T00-00-01.jsonl"),
		[
			JSON.stringify({
				timestamp: "2026-02-18T00:00:00.000Z",
				type: "event_msg",
				payload: { type: "user_message", message: "count files" },
			}),
			JSON.stringify({
				timestamp: "2026-02-18T00:00:01.000Z",
				type: "event_msg",
				payload: {
					type: "agent_message",
					message: "TypeScript files in src/ recursively: 102",
				},
			}),
			JSON.stringify({
				timestamp: "2026-02-18T00:00:02.000Z",
				type: "event_msg",
				payload: { type: "agent_message", message: "39" },
			}),
			JSON.stringify({
				timestamp: "2026-02-18T00:00:03.000Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					content: [
						{ type: "output_text", text: "TypeScript files in src/ recursively: 102" },
						{ type: "output_text", text: "Test files (*.test.ts) in src/ recursively: 39" },
					],
				},
			}),
		].join("\n"),
	);
}

async function writeCodexParentAndSubagentSessions(runtimeDir: string): Promise<void> {
	const dir = join(runtimeDir, "sessions", "2026", "02", "19");
	await mkdir(dir, { recursive: true });
	await Bun.write(
		join(dir, "rollout-2026-02-19T09-07-16-parent-session.jsonl"),
		JSON.stringify({
			timestamp: "2026-02-19T08:07:34.696Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: "Subagent 1 (`src/**/*.ts`): **102**\nSubagent 2 (`src/**/*.test.ts`): **39**",
					},
				],
			},
		}),
	);
	await Bun.write(
		join(dir, "rollout-2026-02-19T09-07-25-subagent-session.jsonl"),
		JSON.stringify({
			timestamp: "2026-02-19T08:07:30.381Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "rg --files src/ -g '*.test.ts' | wc -l\n39" }],
			},
		}),
	);
	await Bun.write(
		join(runtimeDir, "history.jsonl"),
		JSON.stringify({
			session_id: "parent-session",
			ts: 1771488437,
			text: "parent task",
		}),
	);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("timed out waiting for condition");
		}
		await Bun.sleep(10);
	}
}

function webhookConfig(
	overrides: Partial<WebhookConfig> & Pick<WebhookConfig, "url" | "events">,
): WebhookConfig {
	return {
		url: overrides.url,
		events: overrides.events,
		token: overrides.token,
		safetyNet:
			overrides.safetyNet ??
			({
				enabled: false,
				intervalMs: 30000,
				stuckAfterMs: 180000,
				stuckWarnIntervalMs: 300000,
			} satisfies WebhookConfig["safetyNet"]),
	};
}

describe("webhook/client", () => {
	it("posts completion webhook with last assistant message", async () => {
		const runtimeDir = await mkdtemp(join(tmpdir(), "ah-webhook-client-"));
		tempDirs.push(runtimeDir);
		await writeCodexSession(runtimeDir);

		const store = createStore();
		const agent = finalizedAgent(
			{
				finalMessage: "latest answer",
				finalMessageSource: "internals_codex_jsonl",
			},
			runtimeDir,
		);
		store.addAgent(agent);
		const bus = createEventBus(100);

		const calls: Array<{ url: string; auth: string | null; payload: unknown }> = [];
		(globalThis as { fetch: typeof fetch }).fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			calls.push({
				url: request.url,
				auth: request.headers.get("authorization"),
				payload: await request.json(),
			});
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const config = webhookConfig({
			url: "https://example.test/hook",
			token: "secret",
			events: ["agent_completed"],
		});

		const unsubscribe = createTestWebhookClient(config, store, bus, runtimeDir);
		emitTerminalFinalized(bus, agent);

		await waitFor(() => calls.length === 1);
		expect(calls[0]).toEqual({
			url: "https://example.test/hook",
			auth: "Bearer secret",
			payload: {
				event: "agent_completed",
				project: "proj-1",
				agentId: "abcd1234",
				provider: "codex",
				status: "idle",
				lastMessage: "latest answer",
				timestamp: "2026-02-18T10:00:00.000Z",
				deliveryId: "delivery-1",
			},
		});
		unsubscribe();
	});

	it("uses full multiline response_item assistant content instead of trailing event_msg chunk", async () => {
		const runtimeDir = await mkdtemp(join(tmpdir(), "ah-webhook-client-"));
		tempDirs.push(runtimeDir);
		await writeCodexSessionWithPartialEventChunks(runtimeDir);

		const store = createStore();
		const agent = finalizedAgent(
			{
				finalMessage: [
					"TypeScript files in src/ recursively: 102",
					"Test files (*.test.ts) in src/ recursively: 39",
				].join("\n"),
				finalMessageSource: "internals_codex_jsonl",
			},
			runtimeDir,
		);
		store.addAgent(agent);
		const bus = createEventBus(100);

		const calls: Array<{ payload: unknown }> = [];
		(globalThis as { fetch: typeof fetch }).fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			calls.push({
				payload: await request.json(),
			});
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const config = webhookConfig({
			url: "https://example.test/hook",
			events: ["agent_completed"],
		});

		const unsubscribe = createTestWebhookClient(config, store, bus, runtimeDir);
		emitTerminalFinalized(bus, agent);

		await waitFor(() => calls.length === 1);
		expect(calls[0]?.payload).toEqual({
			event: "agent_completed",
			project: "proj-1",
			agentId: "abcd1234",
			provider: "codex",
			status: "idle",
			lastMessage: [
				"TypeScript files in src/ recursively: 102",
				"Test files (*.test.ts) in src/ recursively: 39",
			].join("\n"),
			timestamp: "2026-02-18T10:00:00.000Z",
			deliveryId: "delivery-1",
		});
		unsubscribe();
	});

	it("uses codex history session id to avoid sending subagent output as lastMessage", async () => {
		const runtimeDir = await mkdtemp(join(tmpdir(), "ah-webhook-client-parent-session-"));
		tempDirs.push(runtimeDir);
		await writeCodexParentAndSubagentSessions(runtimeDir);

		const store = createStore();
		const agent = finalizedAgent(
			{
				finalizedAt: "2026-02-19T10:00:00.000Z",
				finalMessage:
					"Subagent 1 (`src/**/*.ts`): **102**\nSubagent 2 (`src/**/*.test.ts`): **39**",
				finalMessageSource: "internals_codex_jsonl",
			},
			runtimeDir,
		);
		store.addAgent(agent);
		const bus = createEventBus(100);

		const calls: Array<{ payload: unknown }> = [];
		(globalThis as { fetch: typeof fetch }).fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			calls.push({
				payload: await request.json(),
			});
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const unsubscribe = createTestWebhookClient(
			webhookConfig({
				url: "https://example.test/hook",
				events: ["agent_completed"],
			}),
			store,
			bus,
			runtimeDir,
		);
		emitTerminalFinalized(bus, agent);

		await waitFor(() => calls.length === 1);
		expect(calls[0]?.payload).toEqual({
			event: "agent_completed",
			project: "proj-1",
			agentId: "abcd1234",
			provider: "codex",
			status: "idle",
			lastMessage: "Subagent 1 (`src/**/*.ts`): **102**\nSubagent 2 (`src/**/*.test.ts`): **39**",
			timestamp: "2026-02-19T10:00:00.000Z",
			deliveryId: "delivery-1",
		});
		unsubscribe();
	});

	it("uses per-agent callback over global fallback and includes routing fields", async () => {
		const store = createStore();
		const agent = finalizedAgent({
			callback: {
				url: "https://callback.test/hook",
				token: "callback-secret",
				discordChannel: "alerts",
				sessionKey: "session-42",
				extra: { requestId: "req-1" },
			},
		});
		store.addAgent(agent);
		const bus = createEventBus(100);

		const calls: Array<{ url: string; auth: string | null; payload: unknown }> = [];
		(globalThis as { fetch: typeof fetch }).fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			calls.push({
				url: request.url,
				auth: request.headers.get("authorization"),
				payload: await request.json(),
			});
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const unsubscribe = createTestWebhookClient(
			webhookConfig({
				url: "https://global.test/fallback",
				token: "global-secret",
				events: ["agent_completed"],
			}),
			store,
			bus,
		);
		emitTerminalFinalized(bus, agent);

		await waitFor(() => calls.length === 1);
		expect(calls[0]).toEqual({
			url: "https://callback.test/hook",
			auth: "Bearer callback-secret",
			payload: {
				event: "agent_completed",
				project: "proj-1",
				agentId: "abcd1234",
				provider: "codex",
				status: "idle",
				lastMessage: null,
				timestamp: "2026-02-18T10:00:00.000Z",
				deliveryId: "delivery-1",
				discordChannel: "alerts",
				sessionKey: "session-42",
				extra: { requestId: "req-1" },
			},
		});
		unsubscribe();
	});

	it("falls back to project callback when agent callback is missing", async () => {
		const store = createStore();
		store.addProject({
			name: projectName("proj-1"),
			cwd: process.cwd(),
			tmuxSession: "ah-proj-1",
			agentCount: 1,
			callback: {
				url: "https://project-callback.test/hook",
				token: "project-secret",
				discordChannel: "project-alerts",
				sessionKey: "project-session",
				extra: { source: "project-defaults" },
			},
			createdAt: new Date().toISOString(),
		});
		store.addAgent({
			...finalizedAgent(),
		});
		const bus = createEventBus(100);

		const calls: Array<{ url: string; auth: string | null; payload: unknown }> = [];
		(globalThis as { fetch: typeof fetch }).fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			calls.push({
				url: request.url,
				auth: request.headers.get("authorization"),
				payload: await request.json(),
			});
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const unsubscribe = createTestWebhookClient(null, store, bus);
		const storedAgent = store.getAgent(projectName("proj-1"), agentId("abcd1234"));
		if (!storedAgent) throw new Error("agent missing from store");
		emitTerminalFinalized(bus, storedAgent);

		await waitFor(() => calls.length === 1);
		expect(calls[0]).toEqual({
			url: "https://project-callback.test/hook",
			auth: "Bearer project-secret",
			payload: {
				event: "agent_completed",
				project: "proj-1",
				agentId: "abcd1234",
				provider: "codex",
				status: "idle",
				lastMessage: null,
				timestamp: "2026-02-18T10:00:00.000Z",
				deliveryId: "delivery-1",
				discordChannel: "project-alerts",
				sessionKey: "project-session",
				extra: { source: "project-defaults" },
			},
		});
		unsubscribe();
	});

	it("posts per-agent callback even when global webhook config is missing", async () => {
		const store = createStore();
		const agent = finalizedAgent({
			callback: {
				url: "https://callback-only.test/hook",
			},
		});
		store.addAgent(agent);
		const bus = createEventBus(100);

		const urls: string[] = [];
		(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
			urls.push(new Request(input).url);
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const unsubscribe = createTestWebhookClient(null, store, bus);
		emitTerminalFinalized(bus, agent);

		await waitFor(() => urls.length === 1);
		expect(urls[0]).toBe("https://callback-only.test/hook");
		unsubscribe();
	});

	it("posts when terminal status transition starts from non-terminal state", async () => {
		const store = createStore();
		const agent = finalizedAgent();
		store.addAgent(agent);
		const bus = createEventBus(100);

		let callCount = 0;
		(globalThis as { fetch: typeof fetch }).fetch = (async () => {
			callCount++;
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const config = webhookConfig({
			url: "https://example.test/hook",
			events: ["agent_completed"],
		});
		const unsubscribe = createTestWebhookClient(config, store, bus);
		emitTerminalFinalized(bus, agent);

		await waitFor(() => callCount === 1);
		unsubscribe();
	});

	it("does not post on raw status_changed without terminal finalization", async () => {
		const store = createStore();
		store.addAgent(baseAgent());
		const bus = createEventBus(100);

		let callCount = 0;
		(globalThis as { fetch: typeof fetch }).fetch = (async () => {
			callCount++;
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const config = webhookConfig({
			url: "https://example.test/hook",
			events: ["agent_error"],
		});
		const unsubscribe = createTestWebhookClient(config, store, bus);

		bus.emit({
			id: "evt-2b" as EventId,
			ts: "2026-02-18T10:00:00.000Z",
			project: "proj-1",
			agentId: "abcd1234",
			type: "status_changed",
			from: "idle",
			to: "error",
		});

		await Bun.sleep(25);
		expect(callCount).toBe(0);
		unsubscribe();
	});

	it("auto-runs safety-net for per-agent callbacks even without global webhook config", async () => {
		const store = createStore();
		store.addAgent({
			...finalizedAgent(),
			callback: {
				url: "https://callback-only.test/hook",
			},
		});
		const bus = createEventBus(100);

		const urls: string[] = [];
		(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
			urls.push(new Request(input).url);
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const unsubscribe = createTestWebhookClient(null, store, bus);
		await waitFor(() => urls.length === 1);
		expect(urls[0]).toBe("https://callback-only.test/hook");
		unsubscribe();
	});

	it("retries once when first webhook POST fails", async () => {
		const store = createStore();
		const agent = finalizedAgent({
			status: "error",
			terminalStatus: "error",
		});
		store.addAgent(agent);
		const bus = createEventBus(100);

		const statuses: number[] = [];
		(globalThis as { fetch: typeof fetch }).fetch = (async () => {
			if (statuses.length === 0) {
				statuses.push(500);
				return new Response(null, { status: 500 });
			}
			statuses.push(200);
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const config = webhookConfig({
			url: "https://example.test/hook",
			events: ["agent_error"],
		});
		const unsubscribe = createTestWebhookClient(config, store, bus);
		emitTerminalFinalized(bus, agent);

		await waitFor(() => statuses.length === 2);
		expect(statuses).toEqual([500, 200]);
		unsubscribe();
	});

	it("prevents duplicate delivery when the same finalized event arrives twice", async () => {
		const store = createStore();
		const agent = finalizedAgent();
		store.addAgent(agent);
		const bus = createEventBus(100);

		let callCount = 0;
		(globalThis as { fetch: typeof fetch }).fetch = (async () => {
			callCount++;
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const unsubscribe = createTestWebhookClient(
			webhookConfig({
				url: "https://example.test/hook",
				events: ["agent_completed"],
			}),
			store,
			bus,
		);

		emitTerminalFinalized(bus, agent);
		emitTerminalFinalized(bus, agent);

		await waitFor(() => callCount === 1);
		await Bun.sleep(40);
		expect(callCount).toBe(1);
		unsubscribe();
	});

	it("stops posting after unsubscribe", async () => {
		const store = createStore();
		const agent = finalizedAgent();
		store.addAgent(agent);
		const bus = createEventBus(100);

		let callCount = 0;
		(globalThis as { fetch: typeof fetch }).fetch = (async () => {
			callCount++;
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const config = webhookConfig({
			url: "https://example.test/hook",
			events: ["agent_completed"],
		});
		const unsubscribe = createTestWebhookClient(config, store, bus);
		unsubscribe();
		emitTerminalFinalized(bus, agent);

		await Bun.sleep(25);
		expect(callCount).toBe(0);
	});

	it("safety-net posts terminal webhook for already-completed agent", async () => {
		const store = createStore();
		store.addAgent(finalizedAgent());
		const bus = createEventBus(100);

		const calls: Array<{ payload: unknown }> = [];
		(globalThis as { fetch: typeof fetch }).fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			calls.push({
				payload: await request.json(),
			});
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const unsubscribe = createTestWebhookClient(
			webhookConfig({
				url: "https://example.test/hook",
				events: ["agent_completed"],
				safetyNet: {
					enabled: true,
					intervalMs: 20,
					stuckAfterMs: 1000,
					stuckWarnIntervalMs: 1000,
				},
			}),
			store,
			bus,
		);

		await waitFor(() => calls.length === 1);
		expect(calls[0]?.payload).toEqual({
			event: "agent_completed",
			project: "proj-1",
			agentId: "abcd1234",
			provider: "codex",
			status: "idle",
			lastMessage: null,
			timestamp: "2026-02-18T10:00:00.000Z",
			deliveryId: "delivery-1",
		});

		await Bun.sleep(60);
		expect(calls.length).toBe(1);
		unsubscribe();
	});

	it("does not redeliver quiesced sent state on restart safety-net", async () => {
		const store = createStore();
		store.addAgent(
			finalizedAgent({
				deliveryState: "sent",
				deliverySentAt: "2026-02-18T10:00:01.000Z",
			}),
		);
		const bus = createEventBus(100);

		let callCount = 0;
		(globalThis as { fetch: typeof fetch }).fetch = (async () => {
			callCount++;
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const unsubscribe = createTestWebhookClient(
			webhookConfig({
				url: "https://example.test/hook",
				events: ["agent_completed"],
				safetyNet: {
					enabled: true,
					intervalMs: 20,
					stuckAfterMs: 1000,
					stuckWarnIntervalMs: 1000,
				},
			}),
			store,
			bus,
		);

		await Bun.sleep(80);
		expect(callCount).toBe(0);
		unsubscribe();
	});

	it("safety-net retries on next cycle when terminal webhook delivery keeps failing", async () => {
		const store = createStore();
		store.addAgent(finalizedAgent());
		const bus = createEventBus(100);

		let attempts = 0;
		(globalThis as { fetch: typeof fetch }).fetch = (async () => {
			attempts++;
			if (attempts < 3) {
				return new Response(null, { status: 500 });
			}
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const unsubscribe = createTestWebhookClient(
			webhookConfig({
				url: "https://example.test/hook",
				events: ["agent_completed"],
				safetyNet: {
					enabled: true,
					intervalMs: 20,
					stuckAfterMs: 1000,
					stuckWarnIntervalMs: 1000,
				},
			}),
			store,
			bus,
		);

		await waitFor(() => attempts >= 3);
		expect(attempts).toBeGreaterThanOrEqual(3);
		unsubscribe();
	});

	it("does not redeliver sent terminal snapshots after client restart", async () => {
		const runtimeDir = await mkdtemp(join(tmpdir(), "ah-webhook-restart-sent-"));
		tempDirs.push(runtimeDir);

		const store1 = createStore();
		const agent1 = finalizedAgent({}, runtimeDir);
		store1.addAgent(agent1);
		const bus1 = createEventBus(100);

		let calls = 0;
		(globalThis as { fetch: typeof fetch }).fetch = (async () => {
			calls += 1;
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const client1 = createTestWebhookClient(
			webhookConfig({
				url: "https://example.test/hook",
				events: ["agent_completed"],
				safetyNet: {
					enabled: true,
					intervalMs: 20,
					stuckAfterMs: 1000,
					stuckWarnIntervalMs: 1000,
				},
			}),
			store1,
			bus1,
			runtimeDir,
		);
		emitTerminalFinalized(bus1, agent1);
		await waitFor(() => calls === 1);
		client1();

		const store2 = createStore();
		store2.addAgent(await restoredAgentFromDisk(runtimeDir, {}, runtimeDir));
		const bus2 = createEventBus(100);
		const client2 = createTestWebhookClient(
			webhookConfig({
				url: "https://example.test/hook",
				events: ["agent_completed"],
				safetyNet: {
					enabled: true,
					intervalMs: 20,
					stuckAfterMs: 1000,
					stuckWarnIntervalMs: 1000,
				},
			}),
			store2,
			bus2,
			runtimeDir,
		);

		await Bun.sleep(80);
		expect(calls).toBe(1);
		client2();
	});

	it("retries persisted pending terminal snapshots after client restart", async () => {
		const runtimeDir = await mkdtemp(join(tmpdir(), "ah-webhook-restart-pending-"));
		tempDirs.push(runtimeDir);

		const store1 = createStore();
		const agent1 = finalizedAgent({}, runtimeDir);
		store1.addAgent(agent1);
		const bus1 = createEventBus(100);

		let attempts = 0;
		(globalThis as { fetch: typeof fetch }).fetch = (async () => {
			attempts += 1;
			return new Response(null, { status: 500 });
		}) as typeof fetch;

		const client1 = createTestWebhookClient(
			webhookConfig({
				url: "https://example.test/hook",
				events: ["agent_completed"],
				safetyNet: {
					enabled: true,
					intervalMs: 1000,
					stuckAfterMs: 1000,
					stuckWarnIntervalMs: 1000,
				},
			}),
			store1,
			bus1,
			runtimeDir,
		);
		emitTerminalFinalized(bus1, agent1);
		await waitFor(() => attempts === 2);
		client1();

		(globalThis as { fetch: typeof fetch }).fetch = (async () => {
			attempts += 1;
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const store2 = createStore();
		store2.addAgent(await restoredAgentFromDisk(runtimeDir, {}, runtimeDir));
		const bus2 = createEventBus(100);
		const client2 = createTestWebhookClient(
			webhookConfig({
				url: "https://example.test/hook",
				events: ["agent_completed"],
				safetyNet: {
					enabled: true,
					intervalMs: 20,
					stuckAfterMs: 1000,
					stuckWarnIntervalMs: 1000,
				},
			}),
			store2,
			bus2,
			runtimeDir,
		);

		await waitFor(() => attempts >= 3);
		expect(attempts).toBeGreaterThanOrEqual(3);
		client2();
	});
});
