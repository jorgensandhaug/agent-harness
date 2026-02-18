import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebhookConfig } from "../config.ts";
import { createEventBus } from "../events/bus.ts";
import { createStore } from "../session/store.ts";
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

function baseAgent(runtimeDir?: string): Agent {
	const now = new Date().toISOString();
	return {
		id: agentId("abcd1234"),
		project: projectName("proj-1"),
		provider: "codex",
		status: "idle",
		task: "test webhook",
		windowName: "codex-a1",
		tmuxTarget: "ah:codex-a1",
		attachCommand: "tmux attach -t ah",
		providerRuntimeDir: runtimeDir,
		createdAt: now,
		lastActivity: now,
		lastCapturedOutput: "",
	};
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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("timed out waiting for condition");
		}
		await Bun.sleep(10);
	}
}

describe("webhook/client", () => {
	it("posts completion webhook with last assistant message", async () => {
		const runtimeDir = await mkdtemp(join(tmpdir(), "ah-webhook-client-"));
		tempDirs.push(runtimeDir);
		await writeCodexSession(runtimeDir);

		const store = createStore();
		store.addAgent(baseAgent(runtimeDir));
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

		const config: WebhookConfig = {
			url: "https://example.test/hook",
			token: "secret",
			events: ["agent_completed"],
		};

		const unsubscribe = createWebhookClient(config, bus, store);
		bus.emit({
			id: "evt-1" as EventId,
			ts: "2026-02-18T10:00:00.000Z",
			project: "proj-1",
			agentId: "abcd1234",
			type: "status_changed",
			from: "processing",
			to: "idle",
		});

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
			},
		});
		unsubscribe();
	});

	it("does not post when status change does not start from processing", async () => {
		const store = createStore();
		store.addAgent(baseAgent());
		const bus = createEventBus(100);

		let callCount = 0;
		(globalThis as { fetch: typeof fetch }).fetch = (async () => {
			callCount++;
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const config: WebhookConfig = {
			url: "https://example.test/hook",
			events: ["agent_error"],
		};
		const unsubscribe = createWebhookClient(config, bus, store);

		bus.emit({
			id: "evt-2" as EventId,
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

	it("retries once when first webhook POST fails", async () => {
		const store = createStore();
		store.addAgent(baseAgent());
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

		const config: WebhookConfig = {
			url: "https://example.test/hook",
			events: ["agent_error"],
		};
		const unsubscribe = createWebhookClient(config, bus, store);

		bus.emit({
			id: "evt-3" as EventId,
			ts: "2026-02-18T10:00:00.000Z",
			project: "proj-1",
			agentId: "abcd1234",
			type: "status_changed",
			from: "processing",
			to: "error",
		});

		await waitFor(() => statuses.length === 2);
		expect(statuses).toEqual([500, 200]);
		unsubscribe();
	});

	it("stops posting after unsubscribe", async () => {
		const store = createStore();
		store.addAgent(baseAgent());
		const bus = createEventBus(100);

		let callCount = 0;
		(globalThis as { fetch: typeof fetch }).fetch = (async () => {
			callCount++;
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const config: WebhookConfig = {
			url: "https://example.test/hook",
			events: ["agent_completed"],
		};
		const unsubscribe = createWebhookClient(config, bus, store);
		unsubscribe();

		bus.emit({
			id: "evt-4" as EventId,
			ts: "2026-02-18T10:00:00.000Z",
			project: "proj-1",
			agentId: "abcd1234",
			type: "status_changed",
			from: "processing",
			to: "idle",
		});

		await Bun.sleep(25);
		expect(callCount).toBe(0);
	});
});
