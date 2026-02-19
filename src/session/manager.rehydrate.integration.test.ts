import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../config.ts";
import { createEventBus } from "../events/bus.ts";
import * as tmux from "../tmux/client.ts";
import { type Manager, createManager } from "./manager.ts";
import { createStore } from "./store.ts";

const live = process.env.LIVE_TESTS === "1";
const describeLive = live ? describe : describe.skip;

const originalInitialTaskDelay = process.env.HARNESS_INITIAL_TASK_DELAY_MS;
const originalReadyTimeout = process.env.HARNESS_INITIAL_TASK_READY_TIMEOUT_MS;
const cleanupDirs: string[] = [];
const cleanupPrefixes: string[] = [];

type ProviderCase = {
	provider: "codex" | "claude-code";
	agentName: string;
};

const providerCases: ProviderCase[] = [
	{ provider: "codex", agentName: "codex-restart-1" },
	{ provider: "claude-code", agentName: "claude-restart-1" },
];

async function waitFor(
	check: () => Promise<boolean>,
	timeoutMs: number,
	intervalMs = 100,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start <= timeoutMs) {
		if (await check()) return;
		await Bun.sleep(intervalMs);
	}
	throw new Error(`timeout after ${timeoutMs}ms`);
}

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

async function makeStubBinary(binDir: string, name: "codex" | "claude"): Promise<string> {
	const path = join(binDir, name);
	await writeFile(
		path,
		[
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			"echo '> '",
			"while IFS= read -r line; do",
			'  if [ "$line" = "exit" ] || [ "$line" = "/exit" ]; then',
			"    echo 'bye'",
			"    exit 0",
			"  fi",
			"  printf '%s\\n' \"$line\"",
			"  echo '> '",
			"done",
		].join("\n"),
		"utf8",
	);
	await chmod(path, 0o755);
	return path;
}

async function cleanupSessions(prefix: string): Promise<void> {
	const sessions = await tmux.listSessions(prefix);
	if (!sessions.ok) return;
	for (const session of sessions.value) {
		await tmux.killSession(session.name);
	}
}

function makeConfig(
	tmuxPrefix: string,
	logDir: string,
	codexCommand: string,
	claudeCommand: string,
): HarnessConfig {
	return {
		port: 7070,
		tmuxPrefix,
		logDir,
		logLevel: "error",
		pollIntervalMs: 200,
		captureLines: 300,
		maxEventHistory: 1000,
		subscriptions: {},
		providers: {
			"claude-code": {
				command: claudeCommand,
				extraArgs: [],
				env: {},
				enabled: true,
			},
			codex: {
				command: codexCommand,
				extraArgs: [],
				env: {},
				enabled: true,
			},
			pi: {
				command: "pi",
				extraArgs: [],
				env: {},
				enabled: false,
			},
			opencode: {
				command: "opencode",
				extraArgs: [],
				env: {},
				enabled: false,
			},
		},
	};
}

async function waitForOutputContains(
	manager: Manager,
	project: string,
	agentId: string,
	needle: string,
	timeoutMs: number,
): Promise<void> {
	await waitFor(async () => {
		const output = await manager.getAgentOutput(project, agentId, 300);
		return output.ok && output.value.output.includes(needle);
	}, timeoutMs);
}

beforeEach(() => {
	process.env.HARNESS_INITIAL_TASK_DELAY_MS = "60000";
	process.env.HARNESS_INITIAL_TASK_READY_TIMEOUT_MS = "0";
});

afterEach(async () => {
	if (originalInitialTaskDelay === undefined) {
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = undefined;
	} else {
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = originalInitialTaskDelay;
	}
	if (originalReadyTimeout === undefined) {
		process.env.HARNESS_INITIAL_TASK_READY_TIMEOUT_MS = undefined;
	} else {
		process.env.HARNESS_INITIAL_TASK_READY_TIMEOUT_MS = originalReadyTimeout;
	}
	for (const prefix of cleanupPrefixes.splice(0)) {
		await cleanupSessions(prefix);
	}
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describeLive("session/manager.rehydrate.live", () => {
	for (const pc of providerCases) {
		it(`preserves ${pc.provider} pane process across manager restart and reattaches`, async () => {
			const root = await makeTempDir("ah-rehydrate-live-");
			const binDir = join(root, "bin");
			await mkdir(binDir, { recursive: true });
			const codexStub = await makeStubBinary(binDir, "codex");
			const claudeStub = await makeStubBinary(binDir, "claude");

			const tmuxPrefix = `ah-rehydrate-${pc.provider}-${Date.now()}`;
			cleanupPrefixes.push(tmuxPrefix);
			const config = makeConfig(tmuxPrefix, join(root, "logs"), codexStub, claudeStub);
			const project = `pr-${pc.provider.replace(/[^a-z0-9]+/g, "-")}`;

			const store1 = createStore();
			const bus1 = createEventBus(500);
			const manager1 = createManager(config, store1, bus1);
			await manager1.rehydrateProjectsFromTmux();
			await manager1.rehydrateAgentsFromTmux();

			const projectCallback = {
				url: "https://receiver.test/project-default",
				token: "project-token",
				discordChannel: "project-alerts",
				sessionKey: "project-session",
			};
			const agentCallback = {
				url: "https://receiver.test/agent-explicit",
				token: "agent-token",
				discordChannel: "agent-alerts",
				sessionKey: "agent-session",
			};

			const createProject = await manager1.createProject(project, root, projectCallback);
			expect(createProject.ok).toBe(true);
			if (!createProject.ok) throw new Error("project create failed");

			const createAgent = await manager1.createAgent(
				project,
				pc.provider,
				"seed",
				undefined,
				undefined,
				agentCallback,
				pc.agentName,
			);
			expect(createAgent.ok).toBe(true);
			if (!createAgent.ok) throw new Error("agent create failed");
			expect(createAgent.value.callback).toEqual(agentCallback);

			const target = createAgent.value.tmuxTarget;
			const paneIdBefore = await tmux.getPaneVar(target, "pane_id");
			const panePidBefore = await tmux.getPaneVar(target, "pane_pid");
			expect(paneIdBefore.ok).toBe(true);
			expect(panePidBefore.ok).toBe(true);
			if (!paneIdBefore.ok || !panePidBefore.ok) throw new Error("pane vars unavailable");

			const store2 = createStore();
			const bus2 = createEventBus(500);
			const manager2 = createManager(config, store2, bus2);
			await manager2.rehydrateProjectsFromTmux();
			await manager2.rehydrateAgentsFromTmux();

			const recovered = manager2.listAgents(project);
			expect(recovered.ok).toBe(true);
			if (!recovered.ok) throw new Error("list agents failed");
			expect(recovered.value).toHaveLength(1);
			expect(recovered.value[0]?.id).toBe(pc.agentName);
			expect(recovered.value[0]?.provider).toBe(pc.provider);
			expect(recovered.value[0]?.tmuxTarget).toBe(target);
			expect(recovered.value[0]?.callback).toEqual(agentCallback);

			const recoveredProject = manager2.getProject(project);
			expect(recoveredProject.ok).toBe(true);
			if (!recoveredProject.ok) throw new Error("project rehydrate failed");
			expect(recoveredProject.value.callback).toEqual(projectCallback);

			if (pc.provider === "codex") {
				expect(recovered.value[0]?.providerRuntimeDir).toContain(
					`logs/codex/${project}/${pc.agentName}`,
				);
			}
			if (pc.provider === "claude-code") {
				expect(recovered.value[0]?.providerSessionFile).toContain(".jsonl");
			}

			const paneIdAfter = await tmux.getPaneVar(target, "pane_id");
			const panePidAfter = await tmux.getPaneVar(target, "pane_pid");
			expect(paneIdAfter.ok).toBe(true);
			expect(panePidAfter.ok).toBe(true);
			if (!paneIdAfter.ok || !panePidAfter.ok) throw new Error("pane vars unavailable");
			expect(paneIdAfter.value).toBe(paneIdBefore.value);
			expect(panePidAfter.value).toBe(panePidBefore.value);

			const sendInput = await manager2.sendInput(project, pc.agentName, "restart-ping");
			expect(sendInput.ok).toBe(true);
			if (!sendInput.ok) throw new Error("send input failed");

			await waitForOutputContains(manager2, project, pc.agentName, "restart-ping", 8000);

			const deleteProject = await manager2.deleteProject(project);
			expect(deleteProject.ok).toBe(true);
		}, 30000);
	}
});
