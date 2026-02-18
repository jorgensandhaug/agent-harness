import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../config.ts";
import { createDebugTracker } from "../debug/tracker.ts";
import { createEventBus } from "../events/bus.ts";
import { createManager } from "../session/manager.ts";
import { createStore } from "../session/store.ts";
import type { Agent, Project } from "../session/types.ts";
import { agentId, projectName } from "../types.ts";
import { createApp } from "./app.ts";

const originalSpawn = Bun.spawn;
const tempDirs: string[] = [];

function makeConfig(): HarnessConfig {
	return {
		port: 0,
		tmuxPrefix: "ah-messages-route-test",
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

afterEach(async () => {
	(Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("api/messages.routes", () => {
	it("returns provider internals message history and last assistant message", async () => {
		const runtimeDir = await mkdtemp(join(tmpdir(), "ah-api-messages-codex-"));
		tempDirs.push(runtimeDir);
		const sessionDir = join(runtimeDir, "sessions", "2026", "02", "17");
		await mkdir(sessionDir, { recursive: true });
		await Bun.write(
			join(sessionDir, "rollout-2026-02-17T00-00-00.jsonl"),
			[
				JSON.stringify({
					timestamp: "2026-02-17T00:00:00.000Z",
					type: "event_msg",
					payload: { type: "user_message", message: "hello" },
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:01.000Z",
					type: "event_msg",
					payload: { type: "agent_message", message: "world" },
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:02.000Z",
					type: "event_msg",
					payload: { type: "user_message", message: "follow up" },
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:03.000Z",
					type: "event_msg",
					payload: { type: "agent_message", message: "second answer" },
				}),
			].join("\n"),
		);

		const config = makeConfig();
		const store = createStore();
		const eventBus = createEventBus(config.maxEventHistory);
		const debugTracker = createDebugTracker(config, eventBus);
		const manager = createManager(config, store, eventBus, debugTracker);
		const app = createApp(manager, store, eventBus, debugTracker, Date.now());

		const project: Project = {
			name: projectName("p-msg"),
			cwd: process.cwd(),
			tmuxSession: "ah-messages-route-test-p-msg",
			agentCount: 0,
			createdAt: new Date().toISOString(),
		};
		const agent: Agent = {
			id: agentId("abcd1234"),
			project: project.name,
			provider: "codex",
			status: "idle",
			brief: [],
			task: "test",
			windowName: "codex-a1",
			tmuxTarget: `${project.tmuxSession}:codex-a1`,
			attachCommand: `tmux attach -t ${project.tmuxSession}`,
			providerRuntimeDir: runtimeDir,
			createdAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			lastCapturedOutput: "",
		};
		store.addProject(project);
		store.addAgent(agent);

		const messagesRes = await app.fetch(
			new Request("http://localhost/api/v1/projects/p-msg/agents/abcd1234/messages?limit=10"),
		);
		expect(messagesRes.status).toBe(200);
		const messagesJson = await messagesRes.json();
		expect(messagesJson.source).toBe("internals_codex_jsonl");
		expect(messagesJson.messages).toEqual([
			{
				id: null,
				ts: "2026-02-17T00:00:00.000Z",
				role: "user",
				text: "hello",
				finishReason: null,
				sourceRecord: "event_msg:user_message",
			},
			{
				id: null,
				ts: "2026-02-17T00:00:01.000Z",
				role: "assistant",
				text: "world",
				finishReason: null,
				sourceRecord: "event_msg:agent_message",
			},
			{
				id: null,
				ts: "2026-02-17T00:00:02.000Z",
				role: "user",
				text: "follow up",
				finishReason: null,
				sourceRecord: "event_msg:user_message",
			},
			{
				id: null,
				ts: "2026-02-17T00:00:03.000Z",
				role: "assistant",
				text: "second answer",
				finishReason: null,
				sourceRecord: "event_msg:agent_message",
			},
		]);
		expect(messagesJson.lastAssistantMessage?.text).toBe("second answer");

		const lastRes = await app.fetch(
			new Request("http://localhost/api/v1/projects/p-msg/agents/abcd1234/messages/last"),
		);
		expect(lastRes.status).toBe(200);
		expect(lastRes.headers.get("X-Agent-Harness-Mode")).toBe("full");
		const lastJson = await lastRes.json();
		expect(lastJson.source).toBe("internals_codex_jsonl");
		expect(lastJson.lastAssistantMessage?.text).toBe("second answer");

		const compactLastRes = await app.fetch(
			new Request(
				"http://localhost/api/v1/projects/p-msg/agents/abcd1234/messages/last?compact=true",
			),
		);
		expect(compactLastRes.status).toBe(200);
		expect(compactLastRes.headers.get("X-Agent-Harness-Mode")).toBe("compact");
		const compactLastJson = await compactLastRes.json();
		expect(compactLastJson).toEqual({
			text: "second answer",
		});
		debugTracker.stop();
	});
});
