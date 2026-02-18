import { afterEach, describe, expect, it } from "bun:test";
import type { HarnessConfig } from "../config.ts";
import { createDebugTracker } from "../debug/tracker.ts";
import { createEventBus } from "../events/bus.ts";
import type { NormalizedEvent } from "../events/types.ts";
import { createPoller } from "../poller/poller.ts";
import { createManager } from "../session/manager.ts";
import { createStore } from "../session/store.ts";
import * as tmux from "../tmux/client.ts";
import { createApp } from "./app.ts";

const LIVE_MODE = process.env.LIVE_TESTS;
const live = LIVE_MODE === "1";
const describeLive = live ? describe : describe.skip;
const MAX_LIVE_PROVIDER_TESTS = Number.parseInt(process.env.MAX_LIVE_PROVIDER_TESTS ?? "4", 10);
const PROMPT = "Reply with exactly: 4";

type LiveEnv = {
	baseUrl: string;
	server: Bun.Server;
	poller: ReturnType<typeof createPoller>;
	eventBus: ReturnType<typeof createEventBus>;
	debugTracker: ReturnType<typeof createDebugTracker>;
	tmuxPrefix: string;
};

type ProviderCase = {
	provider: "claude-code" | "codex" | "pi" | "opencode";
	command: string;
	modelEnv: string;
};

const providerCases: ProviderCase[] = [
	{ provider: "claude-code", command: "claude", modelEnv: "TEST_MODEL_CLAUDE" },
	{ provider: "codex", command: "codex", modelEnv: "TEST_MODEL_CODEX" },
	{ provider: "pi", command: "pi", modelEnv: "TEST_MODEL_PI" },
	{ provider: "opencode", command: "opencode", modelEnv: "TEST_MODEL_OPENCODE" },
].slice(0, Math.max(0, MAX_LIVE_PROVIDER_TESTS));

let env: LiveEnv | null = null;

function commandExists(command: string): boolean {
	const which = (Bun as { which?: (cmd: string) => string | null }).which;
	if (!which) return true;
	return Boolean(which(command));
}

async function waitFor(
	check: () => boolean | Promise<boolean>,
	timeoutMs: number,
	intervalMs = 200,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start <= timeoutMs) {
		if (await check()) return;
		await Bun.sleep(intervalMs);
	}
	throw new Error(`timeout after ${timeoutMs}ms`);
}

function makeConfig(tmuxPrefix: string): HarnessConfig {
	return {
		port: 0,
		tmuxPrefix,
		logDir: "./logs",
		logLevel: "info",
		pollIntervalMs: 200,
		captureLines: 200,
		maxEventHistory: 5000,
		subscriptions: {},
		providers: {
			"claude-code": {
				command: "claude",
				extraArgs: ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions"],
				env: {},
				enabled: true,
			},
			codex: {
				command: "codex",
				extraArgs: ["--yolo"],
				env: {},
				enabled: true,
			},
			pi: { command: "pi", extraArgs: [], env: {}, enabled: true },
			opencode: { command: "opencode", extraArgs: [], env: {}, enabled: true },
		},
	};
}

async function setupLiveEnv(): Promise<LiveEnv> {
	const tmuxPrefix = `ah-live-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
	const store = createStore();
	const eventBus = createEventBus(5000);
	const config = makeConfig(tmuxPrefix);
	const debugTracker = createDebugTracker(config, eventBus);
	const manager = createManager(config, store, eventBus, debugTracker);
	const poller = createPoller(config, store, manager, eventBus, debugTracker);
	poller.start();
	const app = createApp(manager, store, eventBus, debugTracker, Date.now());
	const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 90 });
	return {
		baseUrl: `http://127.0.0.1:${server.port}`,
		server,
		poller,
		eventBus,
		debugTracker,
		tmuxPrefix,
	};
}

async function cleanupLiveEnv(current: LiveEnv): Promise<void> {
	current.poller.stop();
	current.debugTracker.stop();
	current.server.stop(true);

	const sessions = await tmux.listSessions(current.tmuxPrefix);
	if (sessions.ok) {
		for (const s of sessions.value) {
			await tmux.killSession(s.name);
		}
	}
}

async function api(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
	return fetch(`${baseUrl}${path}`, {
		headers: { "content-type": "application/json" },
		...init,
	});
}

afterEach(async () => {
	if (env) {
		await cleanupLiveEnv(env);
		env = null;
	}
});

describeLive("agents/live-provider.smoke", () => {
	for (const pc of providerCases) {
		const model = process.env[pc.modelEnv];
		const runnable = commandExists(pc.command) && Boolean(model);
		const runner = runnable ? it : it.skip;

		runner(
			`agents/live-${pc.provider}.smoke`,
			async () => {
				env = await setupLiveEnv();
				if (!env) throw new Error("env missing");
				const project = `live-${pc.provider.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
				let agentId: string | null = null;
				const seenEvents: NormalizedEvent[] = [];
				const unsubscribe = env.eventBus.subscribe({ project }, (event) => {
					if (agentId && event.agentId === agentId) {
						seenEvents.push(event);
					}
				});

				try {
					const createProjectRes = await api(env.baseUrl, "/api/v1/projects", {
						method: "POST",
						body: JSON.stringify({ name: project, cwd: process.cwd() }),
					});
					expect(createProjectRes.status).toBe(201);

					const createAgentRes = await api(env.baseUrl, `/api/v1/projects/${project}/agents`, {
						method: "POST",
						body: JSON.stringify({
							provider: pc.provider,
							task: PROMPT,
							model,
						}),
					});
					expect(createAgentRes.status).toBe(201);
					const createAgentJson = await createAgentRes.json();
					agentId = createAgentJson.agent.id as string;
					expect(createAgentJson.agent.status).toBe("starting");
					expect(createAgentJson.agent.attachCommand).toBe(
						`tmux attach -t ${env.tmuxPrefix}-${project}`,
					);
					const debugRes = await fetch(
						`${env.baseUrl}/api/v1/projects/${project}/agents/${agentId}/debug`,
					);
					expect(debugRes.status).toBe(200);

					await waitFor(() => {
						return seenEvents.some((e) => e.type === "status_changed" && e.from === "starting");
					}, 20000);

					await waitFor(() => {
						return seenEvents.some(
							(e) => e.type === "status_changed" && (e.to === "processing" || e.to === "idle"),
						);
					}, 60000);

					await waitFor(() => {
						return seenEvents.some((e) => e.type === "output");
					}, 60000);

					const deleteAgent = await fetch(
						`${env.baseUrl}/api/v1/projects/${project}/agents/${agentId}`,
						{
							method: "DELETE",
						},
					);
					expect(deleteAgent.status).toBe(204);
					agentId = null;

					const deleteProject = await fetch(`${env.baseUrl}/api/v1/projects/${project}`, {
						method: "DELETE",
					});
					expect(deleteProject.status).toBe(204);
				} finally {
					unsubscribe();
					if (agentId) {
						await fetch(`${env.baseUrl}/api/v1/projects/${project}/agents/${agentId}`, {
							method: "DELETE",
						});
					}
					await fetch(`${env.baseUrl}/api/v1/projects/${project}`, { method: "DELETE" });
				}
			},
			90000,
		);
	}
});
