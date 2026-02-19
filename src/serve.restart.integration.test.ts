import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tmux from "./tmux/client.ts";

const live = process.env.LIVE_TESTS === "1";
const describeLive = live ? describe : describe.skip;

const cleanupDirs: string[] = [];
const cleanupPrefixes: string[] = [];
const cleanupProcs: Array<ReturnType<typeof Bun.spawn>> = [];

type ProviderCase = {
	provider: "codex" | "claude-code";
	agentName: string;
};

const providerCases: ProviderCase[] = [
	{ provider: "codex", agentName: "codex-daemon-1" },
	{ provider: "claude-code", agentName: "claude-daemon-1" },
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

async function findFreePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				server.close(() => reject(new Error("failed to resolve free port")));
				return;
			}
			const port = (addr as AddressInfo).port;
			server.close((error) => {
				if (error) reject(error);
				else resolve(port);
			});
		});
	});
}

async function cleanupSessions(prefix: string): Promise<void> {
	const sessions = await tmux.listSessions(prefix);
	if (!sessions.ok) return;
	for (const session of sessions.value) {
		await tmux.killSession(session.name);
	}
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
	await waitFor(async () => {
		try {
			const response = await fetch(`${baseUrl}/api/v1/health`);
			return response.ok;
		} catch {
			return false;
		}
	}, timeoutMs);
}

async function waitForOutputContains(
	baseUrl: string,
	project: string,
	agent: string,
	needle: string,
	timeoutMs: number,
): Promise<void> {
	await waitFor(async () => {
		const response = await fetch(`${baseUrl}/api/v1/projects/${project}/agents/${agent}/output`);
		if (!response.ok) return false;
		const json = (await response.json()) as { output?: unknown };
		return typeof json.output === "string" && json.output.includes(needle);
	}, timeoutMs);
}

async function api(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
	return await fetch(`${baseUrl}${path}`, {
		headers: {
			"content-type": "application/json",
		},
		...init,
	});
}

function spawnDaemon(configPath: string): ReturnType<typeof Bun.spawn> {
	const proc = Bun.spawn([process.execPath, "run", "src/cli/main.ts", "daemon", "serve"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HARNESS_CONFIG: configPath,
			HARNESS_INITIAL_TASK_DELAY_MS: "60000",
			HARNESS_INITIAL_TASK_READY_TIMEOUT_MS: "0",
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	cleanupProcs.push(proc);
	return proc;
}

async function stopDaemon(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<void> {
	try {
		proc.kill("SIGTERM");
	} catch {
		// no-op
	}
	await Promise.race([
		proc.exited.then(() => undefined),
		new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
	]);
}

afterEach(async () => {
	for (const proc of cleanupProcs.splice(0)) {
		await stopDaemon(proc, 3000);
	}
	for (const prefix of cleanupPrefixes.splice(0)) {
		await cleanupSessions(prefix);
	}
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describeLive("serve/restart.live", () => {
	for (const pc of providerCases) {
		it(`preserves ${pc.provider} pane on SIGTERM and reattaches after daemon restart`, async () => {
			const root = await makeTempDir("ah-daemon-restart-");
			const binDir = join(root, "bin");
			await mkdir(binDir, { recursive: true });
			const codexStub = await makeStubBinary(binDir, "codex");
			const claudeStub = await makeStubBinary(binDir, "claude");

			const tmuxPrefix = `ah-daemon-restart-${pc.provider}-${Date.now()}`;
			cleanupPrefixes.push(tmuxPrefix);
			const port = await findFreePort();
			const project = `serve-${pc.provider.replace(/[^a-z0-9]+/g, "-")}`;
			const configPath = join(root, "harness.test.json");
			await writeFile(
				configPath,
				JSON.stringify(
					{
						port,
						bindAddress: "127.0.0.1",
						tmuxPrefix,
						logDir: join(root, "logs"),
						logLevel: "error",
						pollIntervalMs: 200,
						captureLines: 300,
						maxEventHistory: 1000,
						subscriptions: {},
						providers: {
							"claude-code": {
								command: claudeStub,
								extraArgs: [],
								env: {},
								enabled: true,
							},
							codex: {
								command: codexStub,
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
					},
					null,
					2,
				),
				"utf8",
			);

			const baseUrl = `http://127.0.0.1:${port}`;
			const daemon1 = spawnDaemon(configPath);
			await waitForHealth(baseUrl, 12000);

			const createProject = await api(baseUrl, "/api/v1/projects", {
				method: "POST",
				body: JSON.stringify({ name: project, cwd: root }),
			});
			expect(createProject.status).toBe(201);

			const createAgent = await api(baseUrl, `/api/v1/projects/${project}/agents`, {
				method: "POST",
				body: JSON.stringify({
					provider: pc.provider,
					task: "seed",
					name: pc.agentName,
				}),
			});
			expect(createAgent.status).toBe(201);
			const createAgentJson = (await createAgent.json()) as {
				agent?: { tmuxTarget?: unknown };
			};
			const tmuxTarget =
				typeof createAgentJson.agent?.tmuxTarget === "string"
					? createAgentJson.agent.tmuxTarget
					: null;
			expect(tmuxTarget).not.toBeNull();
			if (!tmuxTarget) throw new Error("missing tmuxTarget");

			const paneIdBefore = await tmux.getPaneVar(tmuxTarget, "pane_id");
			const panePidBefore = await tmux.getPaneVar(tmuxTarget, "pane_pid");
			expect(paneIdBefore.ok).toBe(true);
			expect(panePidBefore.ok).toBe(true);
			if (!paneIdBefore.ok || !panePidBefore.ok) throw new Error("pane vars unavailable");

			await stopDaemon(daemon1, 8000);

			const panePidAfterSigterm = await tmux.getPaneVar(tmuxTarget, "pane_pid");
			expect(panePidAfterSigterm.ok).toBe(true);
			if (!panePidAfterSigterm.ok) throw new Error("pane missing after sigterm");
			expect(panePidAfterSigterm.value).toBe(panePidBefore.value);

			const daemon2 = spawnDaemon(configPath);
			await waitForHealth(baseUrl, 12000);

			const getAgent = await api(baseUrl, `/api/v1/projects/${project}/agents/${pc.agentName}`);
			expect(getAgent.status).toBe(200);
			const getAgentJson = (await getAgent.json()) as {
				agent?: { tmuxTarget?: unknown; provider?: unknown };
			};
			expect(getAgentJson.agent?.provider).toBe(pc.provider);
			expect(getAgentJson.agent?.tmuxTarget).toBe(tmuxTarget);

			const paneIdAfterRestart = await tmux.getPaneVar(tmuxTarget, "pane_id");
			const panePidAfterRestart = await tmux.getPaneVar(tmuxTarget, "pane_pid");
			expect(paneIdAfterRestart.ok).toBe(true);
			expect(panePidAfterRestart.ok).toBe(true);
			if (!paneIdAfterRestart.ok || !panePidAfterRestart.ok) {
				throw new Error("pane vars unavailable after restart");
			}
			expect(paneIdAfterRestart.value).toBe(paneIdBefore.value);
			expect(panePidAfterRestart.value).toBe(panePidBefore.value);

			const sendInput = await api(
				baseUrl,
				`/api/v1/projects/${project}/agents/${pc.agentName}/input`,
				{
					method: "POST",
					body: JSON.stringify({ text: "daemon-restart-ping" }),
				},
			);
			expect(sendInput.status).toBe(202);

			await waitForOutputContains(baseUrl, project, pc.agentName, "daemon-restart-ping", 8000);

			const deleteProject = await api(baseUrl, `/api/v1/projects/${project}`, {
				method: "DELETE",
			});
			expect(deleteProject.status).toBe(204);

			await stopDaemon(daemon2, 8000);
		}, 60000);
	}
});
