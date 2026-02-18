import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createDebugTracker } from "../debug/tracker.ts";
import { createEventBus } from "../events/bus.ts";
import type { NormalizedEvent } from "../events/types.ts";
import { createManager } from "../session/manager.ts";
import { createStore } from "../session/store.ts";
import { newEventId } from "../types.ts";
import { createApp } from "./app.ts";

const originalSpawn = Bun.spawn;
const originalInitialTaskDelay = process.env.HARNESS_INITIAL_TASK_DELAY_MS;

type PaneState = {
	id: string;
	session: string;
	window: string;
	buffer: string;
	dead: boolean;
	currentCommand: string;
};

type SessionState = {
	createdAt: number;
	windows: Map<string, PaneState>;
	env: Record<string, string>;
};

class FakeTmux {
	private sessions = new Map<string, SessionState>();
	private pasteBuffer = "";
	private nextPaneId = 1;

	spawn(cmd: readonly string[]): ReturnType<typeof Bun.spawn> {
		if (cmd[0] !== "tmux") {
			return originalSpawn(cmd as string[]);
		}

		const args = cmd.slice(1);
		const sub = args[0] ?? "";
		switch (sub) {
			case "new-session":
				return this.newSession(args);
			case "set-option":
				return this.ok();
			case "set-environment":
				return this.setEnvironment(args);
			case "new-window":
				return this.newWindow(args);
			case "load-buffer":
				return this.loadBuffer(args);
			case "paste-buffer":
				return this.pasteBufferToPane(args);
			case "send-keys":
				return this.sendKeys(args);
			case "capture-pane":
				return this.capturePane(args);
			case "pipe-pane":
				return this.ok();
			case "kill-window":
				return this.killWindow(args);
			case "kill-session":
				return this.killSession(args);
			case "has-session":
				return this.hasSession(args);
			case "list-sessions":
				return this.listSessions();
			case "list-windows":
				return this.listWindows(args);
			case "display-message":
				return this.displayMessage(args);
			default:
				return this.fail(`unknown cmd: ${sub}`);
		}
	}

	private ok(stdout = ""): ReturnType<typeof Bun.spawn> {
		return this.proc(0, stdout, "");
	}

	private fail(stderr: string): ReturnType<typeof Bun.spawn> {
		return this.proc(1, "", stderr);
	}

	private proc(exitCode: number, stdout: string, stderr: string): ReturnType<typeof Bun.spawn> {
		return {
			exited: Promise.resolve(exitCode),
			stdout: new Blob([stdout]).stream(),
			stderr: new Blob([stderr]).stream(),
		} as ReturnType<typeof Bun.spawn>;
	}

	private arg(args: readonly string[], key: string): string | undefined {
		const idx = args.indexOf(key);
		if (idx === -1) return undefined;
		return args[idx + 1];
	}

	private resolvePane(target: string): PaneState | undefined {
		if (target.startsWith("%")) {
			for (const session of this.sessions.values()) {
				for (const pane of session.windows.values()) {
					if (pane.id === target) return pane;
				}
			}
			return undefined;
		}

		const [sessionName, windowName] = target.split(":");
		if (!sessionName || !windowName) return undefined;
		const session = this.sessions.get(sessionName);
		if (!session) return undefined;
		return session.windows.get(windowName);
	}

	private newSession(args: readonly string[]): ReturnType<typeof Bun.spawn> {
		const session = this.arg(args, "-s");
		if (!session) return this.fail("missing session");
		this.sessions.set(session, {
			createdAt: Math.floor(Date.now() / 1000),
			windows: new Map(),
			env: {},
		});
		return this.ok();
	}

	private setEnvironment(args: readonly string[]): ReturnType<typeof Bun.spawn> {
		const sessionName = this.arg(args, "-t");
		if (!sessionName) return this.fail("can't find session");
		const session = this.sessions.get(sessionName);
		if (!session) return this.fail("can't find session");
		const varName = args[args.length - 2];
		const value = args[args.length - 1];
		if (!varName || !value) return this.fail("bad set-environment args");
		session.env[varName] = value;
		return this.ok();
	}

	private newWindow(args: readonly string[]): ReturnType<typeof Bun.spawn> {
		const sessionName = this.arg(args, "-t");
		const windowName = this.arg(args, "-n");
		if (!sessionName || !windowName) return this.fail("can't find session");
		const session = this.sessions.get(sessionName);
		if (!session) return this.fail("can't find session");

		const formatIdx = args.indexOf("#{pane_id}");
		const cmd = formatIdx !== -1 && args[formatIdx + 1] ? args[formatIdx + 1] : "bash";
		const currentCommand = cmd.split(" ")[0] ?? "bash";
		const paneId = `%${this.nextPaneId++}`;

		session.windows.set(windowName, {
			id: paneId,
			session: sessionName,
			window: windowName,
			buffer: "",
			dead: false,
			currentCommand,
		});

		return this.ok(`${paneId}\n`);
	}

	private loadBuffer(args: readonly string[]): ReturnType<typeof Bun.spawn> {
		const path = args[1];
		if (!path) return this.fail("missing path");
		try {
			this.pasteBuffer = readFileSync(path, "utf8");
			return this.ok();
		} catch {
			return this.fail("load buffer failed");
		}
	}

	private pasteBufferToPane(args: readonly string[]): ReturnType<typeof Bun.spawn> {
		const target = this.arg(args, "-t");
		if (!target) return this.fail("can't find window");
		const pane = this.resolvePane(target);
		if (!pane) return this.fail("can't find window");
		if (typeof this.pasteBuffer !== "string") return this.fail("buffer empty");

		const text = this.pasteBuffer;
		pane.buffer += text;
		return this.ok();
	}

	private sendKeys(args: readonly string[]): ReturnType<typeof Bun.spawn> {
		const target = this.arg(args, "-t");
		const key = args[args.length - 1];
		if (!target || !key) return this.fail("can't find window");
		const pane = this.resolvePane(target);
		if (!pane) return this.fail("can't find window");
		if (key === "C-c") {
			pane.buffer += "^C\n";
			pane.currentCommand = "bash";
		}
		return this.ok();
	}

	private capturePane(args: readonly string[]): ReturnType<typeof Bun.spawn> {
		const target = this.arg(args, "-t");
		if (!target) return this.fail("can't find window");
		const pane = this.resolvePane(target);
		if (!pane) return this.fail("can't find window");
		// Simulate interactive prompt once pane is alive so manager readiness probe can proceed.
		return this.ok(`${pane.buffer}\n> `);
	}

	private killWindow(args: readonly string[]): ReturnType<typeof Bun.spawn> {
		const target = this.arg(args, "-t");
		if (!target) return this.fail("can't find window");
		const [sessionName, windowName] = target.split(":");
		if (!sessionName || !windowName) return this.fail("can't find window");
		const session = this.sessions.get(sessionName);
		if (!session || !session.windows.has(windowName)) return this.fail("can't find window");
		session.windows.delete(windowName);
		return this.ok();
	}

	private killSession(args: readonly string[]): ReturnType<typeof Bun.spawn> {
		const target = this.arg(args, "-t");
		if (!target || !this.sessions.has(target)) return this.fail("can't find session");
		this.sessions.delete(target);
		return this.ok();
	}

	private hasSession(args: readonly string[]): ReturnType<typeof Bun.spawn> {
		const target = this.arg(args, "-t");
		if (!target || !this.sessions.has(target)) return this.fail("can't find session");
		return this.ok();
	}

	private listSessions(): ReturnType<typeof Bun.spawn> {
		const lines: string[] = [];
		for (const [name, session] of this.sessions.entries()) {
			lines.push(`${name}\t${session.windows.size}\t${session.createdAt}\t0`);
		}
		return this.ok(lines.join("\n"));
	}

	private listWindows(args: readonly string[]): ReturnType<typeof Bun.spawn> {
		const sessionName = this.arg(args, "-t");
		if (!sessionName) return this.fail("can't find session");
		const session = this.sessions.get(sessionName);
		if (!session) return this.fail("can't find session");
		const lines = Array.from(session.windows.values()).map(
			(pane, idx) => `${idx}\t${pane.window}\t${idx === 0 ? "1" : "0"}\t${pane.id}`,
		);
		return this.ok(lines.join("\n"));
	}

	private displayMessage(args: readonly string[]): ReturnType<typeof Bun.spawn> {
		const target = this.arg(args, "-t");
		const template = args[args.length - 1] ?? "";
		if (!target) return this.fail("can't find window");
		const pane = this.resolvePane(target);
		if (!pane) return this.fail("can't find window");
		if (template === "#{pane_dead}") return this.ok(`${pane.dead ? "1" : "0"}\n`);
		if (template === "#{pane_current_command}") return this.ok(`${pane.currentCommand}\n`);
		return this.ok("\n");
	}
}

type TestEnv = {
	baseUrl: string;
	server: Bun.Server;
	eventBus: ReturnType<typeof createEventBus>;
	debugTracker: ReturnType<typeof createDebugTracker>;
};

function makeConfig() {
	return {
		port: 0,
		tmuxPrefix: "ah-http-test",
		logDir: "./logs",
		logLevel: "error",
		pollIntervalMs: 200,
		captureLines: 200,
		maxEventHistory: 1000,
		subscriptions: {},
		providers: {
			"claude-code": { command: "fake-claude", extraArgs: [], env: {}, enabled: true },
			codex: { command: "fake-codex", extraArgs: [], env: {}, enabled: true },
			pi: { command: "fake-pi", extraArgs: [], env: {}, enabled: true },
			opencode: { command: "fake-opencode", extraArgs: [], env: {}, enabled: true },
		},
	} as const;
}

async function setupEnv(): Promise<TestEnv> {
	const config = makeConfig();
	const store = createStore();
	const eventBus = createEventBus(1000);
	const debugTracker = createDebugTracker(config, eventBus);
	const manager = createManager(config, store, eventBus, debugTracker);
	const app = createApp(manager, store, eventBus, debugTracker, Date.now());
	const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
	return { baseUrl: `http://127.0.0.1:${server.port}`, server, eventBus, debugTracker };
}

async function apiJson(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
	return fetch(`${baseUrl}${path}`, {
		headers: { "content-type": "application/json" },
		...init,
	});
}

type SseStream = {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	abort: () => void;
};

async function openSse(url: string): Promise<SseStream> {
	const controller = new AbortController();
	const response = await fetch(url, {
		headers: { accept: "text/event-stream" },
		signal: controller.signal,
	});
	expect(response.ok).toBe(true);
	if (!response.body) throw new Error("missing SSE body");
	return { reader: response.body.getReader(), abort: () => controller.abort() };
}

async function readSseEvent(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number,
): Promise<{ id?: string; event?: string; data?: string }> {
	let buffer = "";
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const remaining = deadline - Date.now();
		const chunk = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), remaining)),
		]);

		if (chunk.done) throw new Error("stream closed");
		buffer += decoder.decode(chunk.value, { stream: true });
		buffer = buffer.replace(/\r\n/g, "\n");

		const sepIdx = buffer.indexOf("\n\n");
		if (sepIdx === -1) continue;
		const frame = buffer.slice(0, sepIdx);
		buffer = buffer.slice(sepIdx + 2);

		const out: { id?: string; event?: string; data?: string } = {};
		for (const line of frame.split("\n")) {
			if (line.startsWith("id: ")) out.id = line.slice(4);
			if (line.startsWith("event: ")) out.event = line.slice(7);
			if (line.startsWith("data: ")) out.data = line.slice(6);
		}

		if (out.event === "heartbeat") continue;
		return out;
	}

	throw new Error("timeout");
}

let fakeTmux: FakeTmux;
let env: TestEnv | null = null;

beforeEach(async () => {
	fakeTmux = new FakeTmux();
	process.env.HARNESS_INITIAL_TASK_DELAY_MS = "0";
	(Bun as { spawn: typeof Bun.spawn }).spawn = ((cmd: readonly string[]) =>
		fakeTmux.spawn(cmd)) as typeof Bun.spawn;
	env = await setupEnv();
});

afterEach(async () => {
	if (env) {
		env.debugTracker.stop();
		env.server.stop(true);
		env = null;
	}
	(Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
	if (originalInitialTaskDelay === undefined) {
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = undefined;
	} else {
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = originalInitialTaskDelay;
	}
});

describe("http/health", () => {
	it("returns health contract", async () => {
		if (!env) throw new Error("env missing");
		const response = await fetch(`${env.baseUrl}/api/v1/health`);
		expect(response.status).toBe(200);
		const json = await response.json();
		expect(typeof json.uptime).toBe("number");
		expect(json.projects).toBe(0);
		expect(json.agents).toBe(0);
		expect(json.tmuxAvailable).toBe(true);
		expect(json.version).toBe("0.1.0");
	});
});

describe("http/subscriptions", () => {
	it("lists configured subscriptions", async () => {
		if (!env) throw new Error("env missing");
		const response = await fetch(`${env.baseUrl}/api/v1/subscriptions`);
		expect(response.status).toBe(200);
		const json = await response.json();
		expect(Array.isArray(json.subscriptions)).toBe(true);
		expect(json.subscriptions).toEqual([]);
	});
});

describe("http/webhook", () => {
	it("reports webhook unconfigured and rejects test calls", async () => {
		if (!env) throw new Error("env missing");
		const statusResponse = await fetch(`${env.baseUrl}/api/v1/webhook/status`);
		expect(statusResponse.status).toBe(200);
		const statusJson = await statusResponse.json();
		expect(statusJson.configured).toBe(false);

		const testResponse = await apiJson(env.baseUrl, "/api/v1/webhook/test", {
			method: "POST",
			body: "{}",
		});
		expect(testResponse.status).toBe(400);
		const testJson = await testResponse.json();
		expect(testJson.error).toBe("WEBHOOK_NOT_CONFIGURED");

		const probeResponse = await apiJson(env.baseUrl, "/api/v1/webhook/probe-receiver", {
			method: "POST",
			body: "{}",
		});
		expect(probeResponse.status).toBe(400);
		const probeJson = await probeResponse.json();
		expect(probeJson.error).toBe("WEBHOOK_NOT_CONFIGURED");
	});
});

describe("http/projects.crud", () => {
	it("supports create/list/get/delete project endpoints", async () => {
		if (!env) throw new Error("env missing");
		const created = await apiJson(env.baseUrl, "/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: "p-http", cwd: process.cwd() }),
		});
		expect(created.status).toBe(201);

		const listed = await fetch(`${env.baseUrl}/api/v1/projects`);
		expect(listed.status).toBe(200);
		const listedJson = await listed.json();
		expect(listedJson.projects.length).toBe(1);
		expect(listedJson.projects[0].name).toBe("p-http");

		const got = await fetch(`${env.baseUrl}/api/v1/projects/p-http`);
		expect(got.status).toBe(200);
		const gotJson = await got.json();
		expect(gotJson.project.name).toBe("p-http");
		expect(gotJson.agents).toEqual([]);

		const deleted = await fetch(`${env.baseUrl}/api/v1/projects/p-http`, { method: "DELETE" });
		expect(deleted.status).toBe(204);
	});

	it("includes tmuxTarget in project agent summaries", async () => {
		if (!env) throw new Error("env missing");
		await apiJson(env.baseUrl, "/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: "p-http-targets", cwd: process.cwd() }),
		});

		const createAgentRes = await apiJson(env.baseUrl, "/api/v1/projects/p-http-targets/agents", {
			method: "POST",
			body: JSON.stringify({
				provider: "claude-code",
				task: "Reply with exactly: 4",
			}),
		});
		expect(createAgentRes.status).toBe(201);
		const createAgentJson = await createAgentRes.json();
		const agentId = createAgentJson.agent.id as string;

		const got = await fetch(`${env.baseUrl}/api/v1/projects/p-http-targets`);
		expect(got.status).toBe(200);
		const gotJson = await got.json();
		expect(gotJson.agents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: agentId,
					tmuxTarget: expect.stringContaining("ah-http-test-p-http-targets:"),
				}),
			]),
		);
	});
});

describe("http/agents.crud-input-output-abort", () => {
	it("supports agent create/input/output/abort/delete", async () => {
		if (!env) throw new Error("env missing");
		await apiJson(env.baseUrl, "/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: "p-agents", cwd: process.cwd() }),
		});

		const createAgentRes = await apiJson(env.baseUrl, "/api/v1/projects/p-agents/agents", {
			method: "POST",
			body: JSON.stringify({
				provider: "claude-code",
				task: "Reply with exactly: 4",
				model: "cheap",
			}),
		});
		expect(createAgentRes.status).toBe(201);
		expect(createAgentRes.headers.get("X-Agent-Harness-Mode")).toBe("full");
		const createAgentJson = await createAgentRes.json();
		const agentId = createAgentJson.agent.id as string;
		expect(createAgentJson.agent.attachCommand).toBe("tmux attach -t ah-http-test-p-agents");

		const debugRes = await fetch(`${env.baseUrl}/api/v1/projects/p-agents/agents/${agentId}/debug`);
		expect(debugRes.status).toBe(200);
		const debugJson = await debugRes.json();
		expect(debugJson.debug.poll.pollIntervalMs).toBe(200);
		expect(debugJson.debug.poll.captureLines).toBe(200);
		expect(debugJson.debug.stream.emittedCounts.agent_started).toBe(1);

		const inputRes = await apiJson(
			env.baseUrl,
			`/api/v1/projects/p-agents/agents/${agentId}/input`,
			{
				method: "POST",
				body: JSON.stringify({ text: "hello" }),
			},
		);
		expect(inputRes.status).toBe(202);
		const debugAfterInputRes = await fetch(
			`${env.baseUrl}/api/v1/projects/p-agents/agents/${agentId}/debug`,
		);
		expect(debugAfterInputRes.status).toBe(200);
		const debugAfterInputJson = await debugAfterInputRes.json();
		expect(debugAfterInputJson.debug.stream.emittedCounts.input_sent).toBeGreaterThanOrEqual(1);

		const outputRes = await fetch(
			`${env.baseUrl}/api/v1/projects/p-agents/agents/${agentId}/output`,
		);
		expect(outputRes.status).toBe(200);
		const outputJson = await outputRes.json();
		expect(outputJson.output).toContain("hello");

		const abortRes = await apiJson(
			env.baseUrl,
			`/api/v1/projects/p-agents/agents/${agentId}/abort`,
			{
				method: "POST",
				body: "{}",
			},
		);
		expect(abortRes.status).toBe(202);

		const deleteAgentRes = await fetch(
			`${env.baseUrl}/api/v1/projects/p-agents/agents/${agentId}`,
			{
				method: "DELETE",
			},
		);
		expect(deleteAgentRes.status).toBe(204);
	});

	it("supports compact mode for create/get/list agent endpoints", async () => {
		if (!env) throw new Error("env missing");
		await apiJson(env.baseUrl, "/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: "p-agents-compact", cwd: process.cwd() }),
		});

		const createAgentRes = await apiJson(
			env.baseUrl,
			"/api/v1/projects/p-agents-compact/agents?compact=true",
			{
				method: "POST",
				body: JSON.stringify({
					provider: "claude-code",
					task: "Reply with exactly: 4",
				}),
			},
		);
		expect(createAgentRes.status).toBe(201);
		expect(createAgentRes.headers.get("X-Agent-Harness-Mode")).toBe("compact");
		const createAgentJson = await createAgentRes.json();
		expect(createAgentJson.agent).toEqual({
			id: expect.any(String),
			status: expect.any(String),
			tmuxTarget: expect.stringContaining("ah-http-test-p-agents-compact:"),
			attachCommand: "tmux attach -t ah-http-test-p-agents-compact",
		});
		const agentId = createAgentJson.agent.id as string;

		const getAgentRes = await fetch(
			`${env.baseUrl}/api/v1/projects/p-agents-compact/agents/${agentId}?compact=true`,
		);
		expect(getAgentRes.status).toBe(200);
		expect(getAgentRes.headers.get("X-Agent-Harness-Mode")).toBe("compact");
		const getAgentJson = await getAgentRes.json();
		expect(getAgentJson.agent).toEqual({
			id: agentId,
			status: expect.any(String),
			tmuxTarget: expect.stringContaining("ah-http-test-p-agents-compact:"),
			brief: expect.any(String),
		});

		const listRes = await fetch(
			`${env.baseUrl}/api/v1/projects/p-agents-compact/agents?compact=true`,
		);
		expect(listRes.status).toBe(200);
		expect(listRes.headers.get("X-Agent-Harness-Mode")).toBe("compact");
		const listJson = await listRes.json();
		expect(listJson.agents).toEqual(
			expect.arrayContaining([
				{
					id: agentId,
					provider: "claude-code",
					status: expect.any(String),
					tmuxTarget: expect.stringContaining("ah-http-test-p-agents-compact:"),
					brief: expect.any(String),
				},
			]),
		);
	});

	it("returns 400 when requested subscription does not exist", async () => {
		if (!env) throw new Error("env missing");
		await apiJson(env.baseUrl, "/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: "p-agents-missing-sub", cwd: process.cwd() }),
		});

		const createAgentRes = await apiJson(
			env.baseUrl,
			"/api/v1/projects/p-agents-missing-sub/agents",
			{
				method: "POST",
				body: JSON.stringify({
					provider: "codex",
					task: "Reply with exactly: 4",
					subscription: "does-not-exist",
				}),
			},
		);
		expect(createAgentRes.status).toBe(400);
		const body = await createAgentRes.json();
		expect(body.error).toBe("INVALID_REQUEST");
		expect(body.message).toContain("Subscription 'does-not-exist' not found");
	});

	it("accepts callback routing object on agent create", async () => {
		if (!env) throw new Error("env missing");
		await apiJson(env.baseUrl, "/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: "p-agents-callback", cwd: process.cwd() }),
		});

		const createAgentRes = await apiJson(env.baseUrl, "/api/v1/projects/p-agents-callback/agents", {
			method: "POST",
			body: JSON.stringify({
				provider: "codex",
				task: "Reply with exactly: 4",
				callback: {
					url: "https://receiver.test/harness-webhook",
					token: "cb-token",
					discordChannel: "alerts",
					sessionKey: "session-main",
					extra: {
						requestId: "req-1",
					},
				},
			}),
		});
		expect(createAgentRes.status).toBe(201);
		const createAgentJson = await createAgentRes.json();
		expect(createAgentJson.agent.callback).toEqual({
			url: "https://receiver.test/harness-webhook",
			discordChannel: "alerts",
			sessionKey: "session-main",
			extra: {
				requestId: "req-1",
			},
		});
	});
});

describe("http/events.sse.project-stream", () => {
	it("streams project events and replays with since", async () => {
		if (!env) throw new Error("env missing");
		await apiJson(env.baseUrl, "/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: "p-events", cwd: process.cwd() }),
		});

		const event1: NormalizedEvent = {
			id: newEventId(),
			ts: new Date().toISOString(),
			project: "p-events",
			agentId: "a1",
			type: "output",
			text: "online",
		};

		const open1 = openSse(`${env.baseUrl}/api/v1/projects/p-events/events`);
		await Bun.sleep(100);
		env.eventBus.emit(event1);
		const stream1 = await open1;
		const first = await readSseEvent(stream1.reader, 3000);
		stream1.abort();
		expect(first.id).toBe(event1.id);

		const missed: NormalizedEvent = {
			id: newEventId(),
			ts: new Date().toISOString(),
			project: "p-events",
			agentId: "a1",
			type: "output",
			text: "missed",
		};
		env.eventBus.emit(missed);

		// Wake the second stream even if replay buffers flush slowly in this runtime.
		const wake: NormalizedEvent = {
			id: newEventId(),
			ts: new Date().toISOString(),
			project: "p-events",
			agentId: "a1",
			type: "output",
			text: "wake",
		};
		const open2 = openSse(`${env.baseUrl}/api/v1/projects/p-events/events?since=${event1.id}`);
		await Bun.sleep(100);
		env.eventBus.emit(wake);
		const stream2 = await open2;
		const replayed = await readSseEvent(stream2.reader, 3000);
		stream2.abort();

		expect(replayed.id).toBe(missed.id);
		expect(replayed.event).toBe("output");
	}, 15000);
});

describe("http/events.sse.agent-stream", () => {
	it("filters events to selected agent", async () => {
		if (!env) throw new Error("env missing");
		await apiJson(env.baseUrl, "/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: "p-agent-events", cwd: process.cwd() }),
		});

		const a1Res = await apiJson(env.baseUrl, "/api/v1/projects/p-agent-events/agents", {
			method: "POST",
			body: JSON.stringify({ provider: "claude-code", task: "Reply with exactly: 4" }),
		});
		const a2Res = await apiJson(env.baseUrl, "/api/v1/projects/p-agent-events/agents", {
			method: "POST",
			body: JSON.stringify({ provider: "claude-code", task: "Reply with exactly: 4" }),
		});
		const a1 = (await a1Res.json()).agent.id as string;
		const a2 = (await a2Res.json()).agent.id as string;

		const stream = await openSse(
			`${env.baseUrl}/api/v1/projects/p-agent-events/agents/${a1}/events`,
		);

		env.eventBus.emit({
			id: newEventId(),
			ts: new Date().toISOString(),
			project: "p-agent-events",
			agentId: a2,
			type: "output",
			text: "from-a2",
		});
		env.eventBus.emit({
			id: newEventId(),
			ts: new Date().toISOString(),
			project: "p-agent-events",
			agentId: a1,
			type: "output",
			text: "from-a1",
		});

		const event = await readSseEvent(stream.reader, 3000);
		stream.abort();
		const payload = JSON.parse(event.data ?? "{}") as NormalizedEvent;
		expect(payload.agentId).toBe(a1);
	}, 15000);
});
