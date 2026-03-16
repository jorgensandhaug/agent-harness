import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../config.ts";
import { createDebugTracker } from "../debug/tracker.ts";
import { createEventBus } from "../events/bus.ts";
import type { NormalizedEvent } from "../events/types.ts";
import { createPoller } from "../poller/poller.ts";
import * as tmux from "../tmux/client.ts";
import { createManager } from "./manager.ts";
import { createStore } from "./store.ts";

const originalSpawn = Bun.spawn;
const originalDelay = process.env.HARNESS_INITIAL_TASK_DELAY_MS;
const originalReadyTimeout = process.env.HARNESS_INITIAL_TASK_READY_TIMEOUT_MS;
const originalPasteEnterDelay = process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS;
const originalCodexFollowupSettle = process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS;

type SessionState = {
	path: string;
	createdAt: number;
	allowRename: boolean;
	automaticRename: boolean;
	windows: Map<
		string,
		{
			paneId: string;
			buffer: string;
			provider: string;
			startCommand: string;
			currentCommand: string;
			paneDead: boolean;
			createdAtMs: number;
			readyAfterMs: number;
			startupConfirmVisibleAfterMs: number;
			requiresStartupConfirm: boolean;
			startupConfirmed: boolean;
			enterKeyCount: number;
			lastPasteAtMs: number;
			minSubmitDelayMs: number;
			pendingCollapsedPasteSubmit: boolean;
			collapsedPasteMarkerArmedAtMs: number;
			collapsedPasteMarkerInjected: boolean;
			collapsedPasteChars: number;
			submitCount: number;
		}
	>;
};

type FakeTmuxState = {
	sessions: Map<string, SessionState>;
	nextPaneId: number;
	pasteBuffers: Map<string, string>;
};

const fake: FakeTmuxState = {
	sessions: new Map(),
	nextPaneId: 1,
	pasteBuffers: new Map(),
};
let simulateSlowCodexStartup = false;
let simulateClaudeStartupConfirm = false;
let simulateCodexStartupConfirm = false;
let simulateStartupConfirmVisibleAfterMs = 0;
let simulateCodexPasteEnterRace = false;
let simulateCodexCollapsedPasteSubmit = false;
let simulateCodexCollapsedPasteMarkerDelayMs = 0;
const cleanupDirs: string[] = [];

function resetFake(): void {
	fake.sessions.clear();
	fake.nextPaneId = 1;
	fake.pasteBuffers.clear();
}

function proc(exitCode: number, stdout = "", stderr = ""): ReturnType<typeof Bun.spawn> {
	return {
		exited: Promise.resolve(exitCode),
		stdout: new Blob([stdout]).stream(),
		stderr: new Blob([stderr]).stream(),
	} as ReturnType<typeof Bun.spawn>;
}

function arg(args: readonly string[], key: string): string | undefined {
	const idx = args.indexOf(key);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

function commandFromStartCommand(startCommand: string): string {
	const normalized = startCommand.replace(/^env\s+/, "");
	const parts = normalized.split(/\s+/).filter((part) => part.length > 0);
	for (const part of parts) {
		if (part === "-u") continue;
		if (part.includes("=")) continue;
		return part.replace(/^['"]|['"]$/g, "");
	}
	return "sh";
}

function collapsedPasteMarkers(charCount: number): string {
	if (charCount <= 0) return "";
	const chunks: number[] = [];
	let remaining = charCount;
	if (remaining > 9216) {
		chunks.push(9216);
		remaining -= 9216;
	}
	while (remaining > 0) {
		const size = Math.min(1024, remaining);
		chunks.push(size);
		remaining -= size;
	}
	return chunks.map((size) => `[Pasted Content ${size} chars]`).join("");
}

function extractPromptFilePath(text: string): string | null {
	const match = text.match(/(\/[^\s"'`]+prompt-cache[^\s"'`]*\.txt)/);
	return match?.[1] ?? null;
}

function startupTrustPromptLines(provider: string): string[] {
	if (provider === "codex") {
		return [
			"OpenAI Codex",
			"",
			"Do you trust the contents of this directory?",
			"Press enter to continue",
		];
	}
	return [
		"Accessing workspace:",
		"",
		"/tmp/fake",
		"",
		"Quick safety check: Is this a project you created or one you trust?",
		"1. Yes, I trust this folder",
		"2. No, exit",
		"",
		"Enter to confirm",
	];
}

function resolveWindow(target: string): { session: SessionState; windowName: string } | null {
	const [sessionName, windowName] = target.split(":");
	if (!sessionName || !windowName) return null;
	const session = fake.sessions.get(sessionName);
	if (!session) return null;
	return { session, windowName };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

beforeEach(() => {
	resetFake();
	process.env.HARNESS_INITIAL_TASK_DELAY_MS = "10";
	process.env.HARNESS_INITIAL_TASK_READY_TIMEOUT_MS = "600";
	process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS = "0";
	process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS = "0";
	simulateSlowCodexStartup = false;
	simulateClaudeStartupConfirm = false;
	simulateCodexStartupConfirm = false;
	simulateStartupConfirmVisibleAfterMs = 0;
	simulateCodexPasteEnterRace = false;
	simulateCodexCollapsedPasteSubmit = false;
	simulateCodexCollapsedPasteMarkerDelayMs = 0;

	(Bun as { spawn: typeof Bun.spawn }).spawn = ((cmd: readonly string[]) => {
		if (cmd[0] !== "tmux") {
			return originalSpawn(cmd as string[]);
		}

		const args = cmd.slice(1);
		const sub = args[0] ?? "";
		switch (sub) {
			case "new-session": {
				const name = arg(args, "-s");
				const cwd = arg(args, "-c");
				if (!name) return proc(1, "", "missing session");
				fake.sessions.set(name, {
					path: cwd ?? ".",
					createdAt: Math.floor(Date.now() / 1000),
					allowRename: true,
					automaticRename: true,
					windows: new Map(),
				});
				return proc(0);
			}
			case "set-option": {
				const sessionName = arg(args, "-t");
				const option = args[args.length - 2];
				const value = args[args.length - 1];
				if (!sessionName || !option || !value) return proc(1, "", "bad set-option");
				const session = fake.sessions.get(sessionName);
				if (!session) return proc(1, "", "can't find session");
				if (option === "allow-rename") session.allowRename = value !== "off";
				if (option === "automatic-rename") session.automaticRename = value !== "off";
				return proc(0);
			}
			case "set-environment":
				return proc(0);
			case "new-window": {
				const sessionName = arg(args, "-t");
				const requestedName = arg(args, "-n");
				if (!sessionName || !requestedName) return proc(1, "", "can't find session");
				const session = fake.sessions.get(sessionName);
				if (!session) return proc(1, "", "can't find session");

				const paneId = `%${fake.nextPaneId++}`;
				let actualName = requestedName;
				// Simulate tmux auto-renaming that would break session:window targets.
				if (session.allowRename && session.automaticRename) {
					actualName = "renamed-window";
				}
				const startCommand = args[args.length - 1] ?? "sh";
				const currentCommand = commandFromStartCommand(startCommand);
				const provider = requestedName.split("-")[0] ?? currentCommand;
				session.windows.set(actualName, {
					paneId,
					buffer: "",
					provider,
					startCommand,
					currentCommand,
					paneDead: false,
					createdAtMs: Date.now(),
					readyAfterMs: simulateSlowCodexStartup && provider === "codex" ? 350 : 0,
					startupConfirmVisibleAfterMs: simulateStartupConfirmVisibleAfterMs,
					requiresStartupConfirm:
						(simulateClaudeStartupConfirm && provider === "claude") ||
						(simulateCodexStartupConfirm && provider === "codex"),
					startupConfirmed: false,
					enterKeyCount: 0,
					lastPasteAtMs: 0,
					minSubmitDelayMs: simulateCodexPasteEnterRace && provider === "codex" ? 100 : 0,
					pendingCollapsedPasteSubmit: false,
					collapsedPasteMarkerArmedAtMs: 0,
					collapsedPasteMarkerInjected: false,
					collapsedPasteChars: 0,
					submitCount: 0,
				});
				return proc(0, `${paneId}\n`);
			}
			case "load-buffer": {
				const namedBuffer = arg(args, "-b");
				const namedBufferIndex = args.indexOf("-b");
				const path = namedBuffer
					? namedBufferIndex !== -1
						? args[namedBufferIndex + 2]
						: undefined
					: args[1];
				if (!path) return proc(1, "", "missing path");
				try {
					const key = namedBuffer ?? "__default__";
					fake.pasteBuffers.set(key, readFileSync(path, "utf8"));
					return proc(0);
				} catch {
					return proc(1, "", "load buffer failed");
				}
			}
			case "paste-buffer": {
				const target = arg(args, "-t");
				const namedBuffer = arg(args, "-b");
				if (!target) return proc(1, "", "can't find window");
				const resolved = resolveWindow(target);
				if (!resolved) return proc(1, "", "can't find window");
				const window = resolved.session.windows.get(resolved.windowName);
				if (!window) return proc(1, "", "can't find window");
				const key = namedBuffer ?? "__default__";
				const text = fake.pasteBuffers.get(key);
				if (typeof text !== "string") return proc(1, "", "buffer empty");
				const shouldDelete = args.includes("-d");
				if (shouldDelete) {
					fake.pasteBuffers.delete(key);
				}
				window.lastPasteAtMs = Date.now();
				if (window.requiresStartupConfirm && !window.startupConfirmed) {
					// Startup prompt swallows pasted task text until user confirms trust prompt.
					return proc(0);
				}
				const ageMs = Date.now() - window.createdAtMs;
				if (ageMs < window.readyAfterMs) {
					// Simulate provider not ready yet: keystrokes are ignored during startup.
					return proc(0);
				}
				if (
					simulateCodexCollapsedPasteSubmit &&
					window.provider === "codex" &&
					text.length >= 256
				) {
					window.pendingCollapsedPasteSubmit = true;
					window.collapsedPasteChars = text.length;
					window.collapsedPasteMarkerArmedAtMs =
						Date.now() + simulateCodexCollapsedPasteMarkerDelayMs;
					if (simulateCodexCollapsedPasteMarkerDelayMs <= 0) {
						window.collapsedPasteMarkerInjected = true;
						window.buffer += collapsedPasteMarkers(text.length);
					} else {
						window.collapsedPasteMarkerInjected = false;
					}
					return proc(0);
				}
				window.buffer += text;
				return proc(0);
			}
			case "send-keys": {
				const target = arg(args, "-t");
				if (!target) return proc(1, "", "can't find window");
				const resolved = resolveWindow(target);
				if (!resolved) return proc(1, "", "can't find window");
				const window = resolved.session.windows.get(resolved.windowName);
				if (!window) return proc(1, "", "can't find window");
				const key = args[args.length - 1];
				if (key === "Enter") {
					window.enterKeyCount++;
					if (
						window.pendingCollapsedPasteSubmit &&
						!window.collapsedPasteMarkerInjected &&
						Date.now() >= window.collapsedPasteMarkerArmedAtMs
					) {
						window.collapsedPasteMarkerInjected = true;
						window.buffer += collapsedPasteMarkers(window.collapsedPasteChars);
					}
					if (window.requiresStartupConfirm && !window.startupConfirmed) {
						window.startupConfirmed = true;
						return proc(0);
					}
					if (window.pendingCollapsedPasteSubmit) {
						if (!window.collapsedPasteMarkerInjected) {
							// Marker not visible yet; Enter is swallowed by codex.
							return proc(0);
						}
						window.pendingCollapsedPasteSubmit = false;
						window.submitCount++;
						window.buffer += "\n";
						return proc(0);
					}
					if (
						window.provider === "codex" &&
						window.minSubmitDelayMs > 0 &&
						Date.now() - window.lastPasteAtMs < window.minSubmitDelayMs
					) {
						// Simulate Codex swallowing Enter when sent immediately after paste.
						return proc(0);
					}
					window.submitCount++;
					window.buffer += "\n";
				}
				return proc(0);
			}
			case "display-message": {
				const target = arg(args, "-t");
				const format = args[args.length - 1] ?? "";
				if (!target) return proc(1, "", "can't find window");
				const resolved = resolveWindow(target);
				if (!resolved) return proc(1, "", "can't find window");
				const window = resolved.session.windows.get(resolved.windowName);
				if (!window) return proc(1, "", "can't find window");
				if (format === "#{pane_dead}") {
					return proc(0, window.paneDead ? "1\n" : "0\n");
				}
				if (format === "#{pane_current_command}") {
					return proc(0, `${window.currentCommand}\n`);
				}
				if (format === "#{pane_start_command}") {
					return proc(0, `${window.startCommand}\n`);
				}
				return proc(0, "\n");
			}
			case "capture-pane": {
				const target = arg(args, "-t");
				if (!target) return proc(1, "", "can't find window");
				const resolved = resolveWindow(target);
				if (!resolved) return proc(1, "", "can't find window");
				const window = resolved.session.windows.get(resolved.windowName);
				if (!window) return proc(1, "", "can't find window");
				const ageMs = Date.now() - window.createdAtMs;
				if (window.requiresStartupConfirm && !window.startupConfirmed) {
					if (ageMs < window.startupConfirmVisibleAfterMs) {
						return proc(0, "booting...\n");
					}
					return proc(0, startupTrustPromptLines(window.provider).join("\n"));
				}
				if (ageMs < window.readyAfterMs) {
					return proc(0, "booting...\n");
				}
				if (
					window.pendingCollapsedPasteSubmit &&
					!window.collapsedPasteMarkerInjected &&
					Date.now() >= window.collapsedPasteMarkerArmedAtMs
				) {
					window.collapsedPasteMarkerInjected = true;
					window.buffer += collapsedPasteMarkers(window.collapsedPasteChars);
				}
				return proc(0, `${window.buffer}\n> `);
			}
			case "list-sessions": {
				const lines = Array.from(fake.sessions.entries()).map(([name, session]) =>
					[name, session.path, String(session.windows.size), String(session.createdAt), "0"].join(
						"\t",
					),
				);
				return proc(0, lines.join("\n"));
			}
			case "list-windows": {
				const sessionName = arg(args, "-t");
				if (!sessionName) return proc(1, "", "can't find session");
				const session = fake.sessions.get(sessionName);
				if (!session) return proc(1, "", "can't find session");
				const lines = Array.from(session.windows.entries()).map(([name, window], idx) =>
					[idx, name, idx === 0 ? "1" : "0", window.paneId].join("\t"),
				);
				return proc(0, lines.join("\n"));
			}
			case "kill-window": {
				const target = arg(args, "-t");
				if (!target) return proc(1, "", "can't find window");
				const resolved = resolveWindow(target);
				if (!resolved) return proc(1, "", "can't find window");
				const deleted = resolved.session.windows.delete(resolved.windowName);
				if (!deleted) return proc(1, "", "can't find window");
				return proc(0);
			}
			case "has-session": {
				const sessionName = arg(args, "-t");
				if (!sessionName || !fake.sessions.has(sessionName))
					return proc(1, "", "can't find session");
				return proc(0);
			}
			case "kill-session": {
				const name = arg(args, "-t");
				if (!name || !fake.sessions.has(name)) return proc(1, "", "can't find session");
				fake.sessions.delete(name);
				return proc(0);
			}
			default:
				return proc(0);
		}
	}) as typeof Bun.spawn;
});

afterEach(async () => {
	(Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
	if (originalDelay === undefined) {
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = undefined;
	} else {
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = originalDelay;
	}
	if (originalReadyTimeout === undefined) {
		process.env.HARNESS_INITIAL_TASK_READY_TIMEOUT_MS = undefined;
	} else {
		process.env.HARNESS_INITIAL_TASK_READY_TIMEOUT_MS = originalReadyTimeout;
	}
	if (originalPasteEnterDelay === undefined) {
		process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS = undefined;
	} else {
		process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS = originalPasteEnterDelay;
	}
	if (originalCodexFollowupSettle === undefined) {
		process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS = undefined;
	} else {
		process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS = originalCodexFollowupSettle;
	}
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitFor(check: () => boolean, timeoutMs: number, intervalMs = 10): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (check()) return;
		await Bun.sleep(intervalMs);
	}
	throw new Error(`timeout after ${timeoutMs}ms`);
}

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

async function writeCodexFinalSession(runtimeDir: string, finalMessage: string): Promise<void> {
	const dir = join(runtimeDir, "sessions", "2026", "02", "18");
	await mkdir(dir, { recursive: true });
	await Bun.write(
		join(dir, "rollout-2026-02-18T00-00-00.jsonl"),
		JSON.stringify({
			timestamp: "2026-02-18T10:00:00.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				phase: "final_answer",
				content: [{ type: "output_text", text: finalMessage }],
			},
		}),
	);
}

async function readPersistedCallbackState(logDir: string): Promise<{
	projects: Record<string, unknown>;
	agents: Record<string, unknown>;
}> {
	const raw = await readFile(join(logDir, "state", "callbacks.json"), "utf8");
	const parsed: unknown = JSON.parse(raw);
	const projects = isRecord(parsed) && isRecord(parsed.projects) ? parsed.projects : {};
	const agents = isRecord(parsed) && isRecord(parsed.agents) ? parsed.agents : {};
	return { projects, agents };
}

async function readPersistedTerminalState(logDir: string): Promise<Record<string, unknown>> {
	try {
		const raw = await readFile(join(logDir, "state", "terminal.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) && isRecord(parsed.agents) ? parsed.agents : {};
	} catch {
		return {};
	}
}

function makeConfig(): HarnessConfig {
	const logDir = join(
		tmpdir(),
		`ah-manager-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
	);
	return {
		port: 0,
		tmuxPrefix: "ah-manager-test",
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

async function writeCodexTerminalSession(
	runtimeDir: string,
	lines: readonly string[],
): Promise<void> {
	const dir = join(runtimeDir, "sessions", "2026", "02", "18");
	await mkdir(dir, { recursive: true });
	await Bun.write(join(dir, "rollout-2026-02-18T10-00-00-thread.jsonl"), `${lines.join("\n")}\n`);
}

describe("session/poller.codex-unknown-filter", () => {
	it("does not emit unknown events for codex unknown parser lines", async () => {
		const config = makeConfig();
		config.pollIntervalMs = 50;
		const store = createStore();
		const eventBus = createEventBus(500);
		const debugTracker = createDebugTracker(config, eventBus);
		const manager = createManager(config, store, eventBus, debugTracker);
		const poller = createPoller(config, store, manager, eventBus, debugTracker);
		const seen: NormalizedEvent[] = [];
		const unsubscribe = eventBus.subscribe({ project: "p-poller-unknown" }, (event) =>
			seen.push(event),
		);

		try {
			const projectRes = await manager.createProject("p-poller-unknown", process.cwd());
			expect(projectRes.ok).toBe(true);
			if (!projectRes.ok) throw new Error("project create failed");

			const createRes = await manager.createAgent("p-poller-unknown", "codex", "initial task");
			expect(createRes.ok).toBe(true);
			if (!createRes.ok) throw new Error("agent create failed");
			const agentId = createRes.value.id;
			const debugKey = `p-poller-unknown:${agentId}`;

			const sendRes = await manager.sendInput("p-poller-unknown", agentId, "***");
			expect(sendRes.ok).toBe(true);
			await poller.poll();
			await waitFor(() => {
				const debug = debugTracker.getAgentDebug(debugKey);
				return (debug?.parser.lastProviderEventsCount ?? 0) >= 1;
			}, 2000);

			const debug = debugTracker.getAgentDebug(debugKey);
			expect(debug?.parser.lastProviderEventsCount).toBeGreaterThanOrEqual(1);
			const unknownEvents = seen.filter(
				(event) => event.agentId === agentId && event.type === "unknown",
			);
			expect(unknownEvents).toHaveLength(0);

			const deleteRes = await manager.deleteProject("p-poller-unknown");
			expect(deleteRes.ok).toBe(true);
		} finally {
			poller.stop();
			debugTracker.stop();
			unsubscribe();
		}
	});

	it("quiesces idle codex agents after finalizing the last assistant message", async () => {
		const logDir = await makeTempDir("ah-poller-quiesce-");
		const config = makeConfig(logDir);
		config.pollIntervalMs = 50;
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(config, store, eventBus);
		const poller = createPoller(config, store, manager, eventBus);
		const seen: NormalizedEvent[] = [];
		const unsubscribe = eventBus.subscribe({ project: "p-poller-quiesce" }, (event) =>
			seen.push(event),
		);

		try {
			const projectRes = await manager.createProject("p-poller-quiesce", process.cwd());
			expect(projectRes.ok).toBe(true);
			if (!projectRes.ok) throw new Error("project create failed");

			const createRes = await manager.createAgent(
				"p-poller-quiesce",
				"codex",
				"initial task",
				undefined,
				undefined,
				undefined,
				"poller-quiesce-1",
			);
			expect(createRes.ok).toBe(true);
			if (!createRes.ok) throw new Error("agent create failed");
			if (!createRes.value.providerRuntimeDir) throw new Error("codex runtime dir missing");

			await writeCodexFinalSession(createRes.value.providerRuntimeDir, "final answer");
			const agent = store.getAgent("p-poller-quiesce", "poller-quiesce-1");
			if (!agent) throw new Error("agent missing from store");
			agent.status = "idle";
			agent.pollState = "finalizing";
			agent.terminalStatus = "idle";
			agent.terminalObservedAt = new Date(Date.now() - 3_000).toISOString();
			agent.terminalQuietSince = new Date(Date.now() - 2_500).toISOString();
			agent.deliveryState = "not_applicable";
			agent.deliveryId = "delivery-finalize-1";
			agent.lastCapturedOutput = "\n> ";
			await manager.persistAgentTerminalState("p-poller-quiesce", "poller-quiesce-1");

			for (let attempt = 0; attempt < 8; attempt += 1) {
				await poller.poll();
				const current = manager.getAgent("p-poller-quiesce", "poller-quiesce-1");
				if (current.ok && current.value.pollState === "quiesced") break;
				await Bun.sleep(60);
			}

			const agentRes = manager.getAgent("p-poller-quiesce", "poller-quiesce-1");
			expect(agentRes.ok).toBe(true);
			if (!agentRes.ok) throw new Error("agent missing after quiesce");
			expect(agentRes.value.status).toBe("idle");
			expect(agentRes.value.pollState).toBe("quiesced");
			expect(agentRes.value.finalMessage).toBe("final answer");
			expect(agentRes.value.finalMessageSource).toBe("internals_codex_jsonl");
			expect(
				seen.some(
					(event) =>
						event.type === "agent_terminal_finalized" &&
						event.agentId === "poller-quiesce-1" &&
						event.status === "idle" &&
						event.lastMessage === "final answer",
				),
			).toBe(true);

			const deleteRes = await manager.deleteProject("p-poller-quiesce");
			expect(deleteRes.ok).toBe(true);
		} finally {
			poller.stop();
			unsubscribe();
		}
	});
});

describe("session/poller.finalization", () => {
	it("finalizes idle agents, captures the last assistant message, and quiesces polling", async () => {
		const config = makeConfig();
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(config, store, eventBus);
		const poller = createPoller(config, store, manager, eventBus);
		const seen: NormalizedEvent[] = [];
		const unsubscribe = eventBus.subscribe({ project: "pf-idle" }, (event) => seen.push(event));

		try {
			const projectRes = await manager.createProject("pf-idle", process.cwd());
			expect(projectRes.ok).toBe(true);
			if (!projectRes.ok) throw new Error("project create failed");

			const createRes = await manager.createAgent(
				"pf-idle",
				"codex",
				"initial task",
				undefined,
				undefined,
				undefined,
				"codex-finalize-idle",
			);
			expect(createRes.ok).toBe(true);
			if (!createRes.ok) throw new Error("agent create failed");
			if (!createRes.value.providerRuntimeDir) throw new Error("missing codex runtime dir");

			await writeCodexTerminalSession(createRes.value.providerRuntimeDir, [
				JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
				JSON.stringify({
					type: "response_item",
					payload: {
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "done" }],
					},
				}),
				JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
			]);

			await poller.poll();
			await poller.poll();
			await Bun.sleep(2100);
			await poller.poll();

			const agentRes = manager.getAgent("pf-idle", "codex-finalize-idle");
			expect(agentRes.ok).toBe(true);
			if (!agentRes.ok) throw new Error("agent missing after finalization");
			expect(agentRes.value.status).toBe("idle");
			expect(agentRes.value.pollState).toBe("quiesced");
			expect(agentRes.value.terminalStatus).toBe("idle");
			expect(agentRes.value.finalMessage).toBe("done");
			expect(agentRes.value.finalizedAt).not.toBeNull();
			expect(agentRes.value.deliveryState).toBe("pending");
			expect(
				seen.some(
					(event) =>
						event.type === "agent_terminal_finalized" &&
						event.agentId === "codex-finalize-idle" &&
						event.status === "idle" &&
						event.lastMessage === "done",
				),
			).toBe(true);
		} finally {
			unsubscribe();
		}
	});

	it("finalizes direct exited agents even when no assistant message is available", async () => {
		const config = makeConfig();
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(config, store, eventBus);
		const poller = createPoller(config, store, manager, eventBus);
		const seen: NormalizedEvent[] = [];
		const unsubscribe = eventBus.subscribe({ project: "pf-exited" }, (event) => seen.push(event));

		try {
			const projectRes = await manager.createProject("pf-exited", process.cwd());
			expect(projectRes.ok).toBe(true);
			if (!projectRes.ok) throw new Error("project create failed");

			const createRes = await manager.createAgent(
				"pf-exited",
				"codex",
				"initial task",
				undefined,
				undefined,
				undefined,
				"codex-finalize-exited",
			);
			expect(createRes.ok).toBe(true);
			if (!createRes.ok) throw new Error("agent create failed");

			const [sessionName, windowName] = createRes.value.tmuxTarget.split(":");
			if (!sessionName || !windowName) throw new Error("bad tmux target");
			const session = fake.sessions.get(sessionName);
			const window = session?.windows.get(windowName);
			if (!window) throw new Error("window missing");
			window.paneDead = true;

			await poller.poll();

			const agentRes = manager.getAgent("pf-exited", "codex-finalize-exited");
			expect(agentRes.ok).toBe(true);
			if (!agentRes.ok) throw new Error("agent missing after exited finalization");
			expect(agentRes.value.status).toBe("exited");
			expect(agentRes.value.pollState).toBe("quiesced");
			expect(agentRes.value.terminalStatus).toBe("exited");
			expect(agentRes.value.finalMessage).toBeNull();
			expect(agentRes.value.finalizedAt).not.toBeNull();
			expect(
				seen.some(
					(event) =>
						event.type === "agent_terminal_finalized" &&
						event.agentId === "codex-finalize-exited" &&
						event.status === "exited" &&
						event.lastMessage === null,
				),
			).toBe(true);
		} finally {
			unsubscribe();
		}
	});
});

describe("session/manager.initial-input", () => {
	it("delivers initial task even if tmux would auto-rename windows", async () => {
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const seen: NormalizedEvent[] = [];
		const unsubscribe = eventBus.subscribe({}, (event) => seen.push(event));

		const projectRes = await manager.createProject("p1", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent("p1", "codex", "Reply with exactly: 4");
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		const agentId = createRes.value.id;

		await waitFor(
			() => seen.some((event) => event.type === "input_sent" && event.agentId === agentId),
			1000,
		);
		const statusEvent = seen.find(
			(event): event is Extract<NormalizedEvent, { type: "status_changed"; source?: string }> =>
				event.type === "status_changed" && event.agentId === agentId && event.to === "processing",
		);
		expect(statusEvent?.source).toBe("manager_initial_input");

		const deleteRes = await manager.deleteProject("p1");
		expect(deleteRes.ok).toBe(true);
		unsubscribe();
	});

	it("passes codex initial task as startup CLI argument", async () => {
		simulateSlowCodexStartup = true;
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("p2", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent("p2", "codex", "Reply with exactly: 4");
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		const target = createRes.value.tmuxTarget;
		const [sessionName, windowName] = target.split(":");
		if (!sessionName || !windowName) throw new Error("bad tmux target");
		const session = fake.sessions.get(sessionName);
		const window = session?.windows.get(windowName);
		if (!window) throw new Error("window missing");
		expect(window.startCommand).toContain("Reply with exactly: 4");
		expect(window.submitCount).toBe(0);

		const deleteRes = await manager.deleteProject("p2");
		expect(deleteRes.ok).toBe(true);
	});

	it("passes claude initial task as startup CLI argument and auto-confirms trust prompt", async () => {
		simulateClaudeStartupConfirm = true;
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("p3", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent("p3", "claude-code", "Reply with exactly: 4");
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		const target = createRes.value.tmuxTarget;
		const [sessionName, windowName] = target.split(":");
		if (!sessionName || !windowName) throw new Error("bad tmux target");
		const session = fake.sessions.get(sessionName);
		const window = session?.windows.get(windowName);
		if (!window) throw new Error("window missing");
		expect(window.startCommand).toContain("Reply with exactly: 4");
		await waitFor(() => window.startupConfirmed, 1500);

		const deleteRes = await manager.deleteProject("p3");
		expect(deleteRes.ok).toBe(true);
	});

	it("passes codex initial task as startup CLI argument and auto-confirms trust prompt", async () => {
		simulateCodexStartupConfirm = true;
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("p3-codex", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent("p3-codex", "codex", "Reply with exactly: 4");
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		const target = createRes.value.tmuxTarget;
		const [sessionName, windowName] = target.split(":");
		if (!sessionName || !windowName) throw new Error("bad tmux target");
		const session = fake.sessions.get(sessionName);
		const window = session?.windows.get(windowName);
		if (!window) throw new Error("window missing");
		expect(window.startCommand).toContain("Reply with exactly: 4");
		await waitFor(() => window.startupConfirmed, 1500);

		const deleteRes = await manager.deleteProject("p3-codex");
		expect(deleteRes.ok).toBe(true);
	});

	it("auto-confirms a codex trust prompt that appears after initial startup delay", async () => {
		simulateCodexStartupConfirm = true;
		simulateStartupConfirmVisibleAfterMs = 300;
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("p3-codex-delayed", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent(
			"p3-codex-delayed",
			"codex",
			"Reply with exactly: 4",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		const target = createRes.value.tmuxTarget;
		const [sessionName, windowName] = target.split(":");
		if (!sessionName || !windowName) throw new Error("bad tmux target");
		const session = fake.sessions.get(sessionName);
		const window = session?.windows.get(windowName);
		if (!window) throw new Error("window missing");

		await waitFor(() => window.startupConfirmed, 1500);

		const deleteRes = await manager.deleteProject("p3-codex-delayed");
		expect(deleteRes.ok).toBe(true);
	});

	it("stores claude session file path with dot-segment-safe project key", async () => {
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);
		const cwdWithDotSegment = "/tmp/.worktrees/claude-path-test";

		const projectRes = await manager.createProject("p3b", cwdWithDotSegment);
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent("p3b", "claude-code", "Reply with exactly: 4");
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		expect(createRes.value.providerSessionFile).toContain(
			"/.claude/projects/-tmp--worktrees-claude-path-test/",
		);
		expect(createRes.value.providerSessionFile).not.toContain("/.claude/projects/-tmp-.worktrees-");

		const deleteRes = await manager.deleteProject("p3b");
		expect(deleteRes.ok).toBe(true);
	});

	it("sendInput delivers follow-up text when startup trust prompt is still blocking", async () => {
		simulateClaudeStartupConfirm = true;
		const priorDelay = process.env.HARNESS_INITIAL_TASK_DELAY_MS;
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = "10000";
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		try {
			const projectRes = await manager.createProject("p4", process.cwd());
			expect(projectRes.ok).toBe(true);
			if (!projectRes.ok) throw new Error("project create failed");

			const createRes = await manager.createAgent("p4", "claude-code", "initial task");
			expect(createRes.ok).toBe(true);
			if (!createRes.ok) throw new Error("agent create failed");
			const target = createRes.value.tmuxTarget;

			const sendRes = await manager.sendInput("p4", createRes.value.id, "follow-up prompt");
			expect(sendRes.ok).toBe(true);

			const containsFollowUp = (): boolean => {
				const [sessionName, windowName] = target.split(":");
				if (!sessionName || !windowName) return false;
				const session = fake.sessions.get(sessionName);
				const window = session?.windows.get(windowName);
				return Boolean(window?.buffer.includes("follow-up prompt"));
			};

			await waitFor(containsFollowUp, 1500);

			const deleteRes = await manager.deleteProject("p4");
			expect(deleteRes.ok).toBe(true);
		} finally {
			if (priorDelay === undefined) {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = undefined;
			} else {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = priorDelay;
			}
		}
	});

	it("sendInput auto-confirms codex trust prompt before follow-up input", async () => {
		simulateCodexStartupConfirm = true;
		const priorDelay = process.env.HARNESS_INITIAL_TASK_DELAY_MS;
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = "10000";
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		try {
			const projectRes = await manager.createProject("p4-codex", process.cwd());
			expect(projectRes.ok).toBe(true);
			if (!projectRes.ok) throw new Error("project create failed");

			const createRes = await manager.createAgent("p4-codex", "codex", "initial task");
			expect(createRes.ok).toBe(true);
			if (!createRes.ok) throw new Error("agent create failed");
			const target = createRes.value.tmuxTarget;

			const sendRes = await manager.sendInput("p4-codex", createRes.value.id, "follow-up prompt");
			expect(sendRes.ok).toBe(true);

			const containsFollowUp = (): boolean => {
				const [sessionName, windowName] = target.split(":");
				if (!sessionName || !windowName) return false;
				const session = fake.sessions.get(sessionName);
				const window = session?.windows.get(windowName);
				return Boolean(window?.buffer.includes("follow-up prompt") && window.startupConfirmed);
			};

			await waitFor(containsFollowUp, 1500);

			const deleteRes = await manager.deleteProject("p4-codex");
			expect(deleteRes.ok).toBe(true);
		} finally {
			if (priorDelay === undefined) {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = undefined;
			} else {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = priorDelay;
			}
		}
	});

	it("sendInput does not auto-confirm when trust prompt text is only in scrollback history", async () => {
		const priorDelay = process.env.HARNESS_INITIAL_TASK_DELAY_MS;
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = "10000";
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		try {
			const projectRes = await manager.createProject("p5", process.cwd());
			expect(projectRes.ok).toBe(true);
			if (!projectRes.ok) throw new Error("project create failed");

			const createRes = await manager.createAgent("p5", "claude-code", "initial task");
			expect(createRes.ok).toBe(true);
			if (!createRes.ok) throw new Error("agent create failed");
			const target = createRes.value.tmuxTarget;
			const [sessionName, windowName] = target.split(":");
			if (!sessionName || !windowName) throw new Error("bad tmux target");
			const session = fake.sessions.get(sessionName);
			const window = session?.windows.get(windowName);
			if (!window) throw new Error("window missing");

			window.startupConfirmed = true;
			window.requiresStartupConfirm = false;
			window.buffer = [
				"Accessing workspace:",
				"Quick safety check: Is this a project you created or one you trust?",
				"Enter to confirm",
				"Claude ready",
				"status ok",
			].join("\n");
			const enterBefore = window.enterKeyCount;

			const sendRes = await manager.sendInput("p5", createRes.value.id, "follow-up clean");
			expect(sendRes.ok).toBe(true);

			expect(window.enterKeyCount).toBe(enterBefore + 1);
			expect(window.buffer).toContain("follow-up clean");

			const deleteRes = await manager.deleteProject("p5");
			expect(deleteRes.ok).toBe(true);
		} finally {
			if (priorDelay === undefined) {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = undefined;
			} else {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = priorDelay;
			}
		}
	});

	it("codex submit survives paste-enter race by settling before follow-up Enter", async () => {
		simulateCodexPasteEnterRace = true;
		const priorDelay = process.env.HARNESS_INITIAL_TASK_DELAY_MS;
		const priorFollowupSettle = process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS;
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = "10000";
		process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS = "120";
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		try {
			const projectRes = await manager.createProject("p6", process.cwd());
			expect(projectRes.ok).toBe(true);
			if (!projectRes.ok) throw new Error("project create failed");

			const createRes = await manager.createAgent("p6", "codex", "initial task");
			expect(createRes.ok).toBe(true);
			if (!createRes.ok) throw new Error("agent create failed");
			const target = createRes.value.tmuxTarget;

			const sendRes = await manager.sendInput("p6", createRes.value.id, "follow-up codex");
			expect(sendRes.ok).toBe(true);

			const submitted = (): boolean => {
				const [sessionName, windowName] = target.split(":");
				if (!sessionName || !windowName) return false;
				const session = fake.sessions.get(sessionName);
				const window = session?.windows.get(windowName);
				return Boolean(window && window.submitCount > 0);
			};

			await waitFor(submitted, 1500);

			const deleteRes = await manager.deleteProject("p6");
			expect(deleteRes.ok).toBe(true);
		} finally {
			if (priorDelay === undefined) {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = undefined;
			} else {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = priorDelay;
			}
			if (priorFollowupSettle === undefined) {
				process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS = undefined;
			} else {
				process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS = priorFollowupSettle;
			}
		}
	});

	it("codex long follow-up stages prompt file and submits pointer instruction", async () => {
		simulateCodexCollapsedPasteSubmit = true;
		const priorDelay = process.env.HARNESS_INITIAL_TASK_DELAY_MS;
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = "10000";
		const priorCodexFollowupSettle = process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS;
		process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS = "400";
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		try {
			const projectRes = await manager.createProject("p7", process.cwd());
			expect(projectRes.ok).toBe(true);
			if (!projectRes.ok) throw new Error("project create failed");

			const createRes = await manager.createAgent("p7", "codex", "initial task");
			expect(createRes.ok).toBe(true);
			if (!createRes.ok) throw new Error("agent create failed");
			const target = createRes.value.tmuxTarget;
			const [sessionName, windowName] = target.split(":");
			if (!sessionName || !windowName) throw new Error("bad tmux target");
			const session = fake.sessions.get(sessionName);
			const window = session?.windows.get(windowName);
			if (!window) throw new Error("window missing");
			const enterBefore = window.enterKeyCount;

			const longPrompt = `Long prompt: ${"abc ".repeat(2800)}`;
			const sendRes = await manager.sendInput("p7", createRes.value.id, longPrompt);
			expect(sendRes.ok).toBe(true);

			expect(window.enterKeyCount).toBe(enterBefore + 1);
			expect(window.submitCount).toBeGreaterThanOrEqual(1);
			expect(window.buffer).toContain("read my instructions in file:");
			expect(window.buffer).not.toContain("[Pasted Content");
			const promptFilePath = extractPromptFilePath(window.buffer);
			expect(promptFilePath).not.toBeNull();
			if (!promptFilePath) throw new Error("prompt file path missing");
			expect(readFileSync(promptFilePath, "utf8")).toBe(longPrompt);

			const deleteRes = await manager.deleteProject("p7");
			expect(deleteRes.ok).toBe(true);
		} finally {
			if (priorDelay === undefined) {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = undefined;
			} else {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = priorDelay;
			}
			if (priorCodexFollowupSettle === undefined) {
				process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS = undefined;
			} else {
				process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS = priorCodexFollowupSettle;
			}
		}
	});

	it("codex delayed collapsed-paste marker still submits follow-up input", async () => {
		simulateCodexCollapsedPasteSubmit = true;
		simulateCodexCollapsedPasteMarkerDelayMs = 350;
		const priorDelay = process.env.HARNESS_INITIAL_TASK_DELAY_MS;
		const priorCodexFollowupSettle = process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS;
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = "10000";
		process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS = "450";
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		try {
			const projectRes = await manager.createProject("p7-delay", process.cwd());
			expect(projectRes.ok).toBe(true);
			if (!projectRes.ok) throw new Error("project create failed");

			const createRes = await manager.createAgent("p7-delay", "codex", "initial task");
			expect(createRes.ok).toBe(true);
			if (!createRes.ok) throw new Error("agent create failed");
			const target = createRes.value.tmuxTarget;
			const [sessionName, windowName] = target.split(":");
			if (!sessionName || !windowName) throw new Error("bad tmux target");
			const session = fake.sessions.get(sessionName);
			const window = session?.windows.get(windowName);
			if (!window) throw new Error("window missing");

			const longPrompt = `Long delayed prompt: ${"delay ".repeat(220)}`;
			const sendRes = await manager.sendInput("p7-delay", createRes.value.id, longPrompt);
			expect(sendRes.ok).toBe(true);

			await waitFor(() => window.submitCount > 0, 3000);
			expect(window.enterKeyCount).toBeGreaterThanOrEqual(1);
			expect(window.pendingCollapsedPasteSubmit).toBe(false);
			expect(window.buffer).toContain("read my instructions in file:");
			const promptFilePath = extractPromptFilePath(window.buffer);
			expect(promptFilePath).not.toBeNull();
			if (!promptFilePath) throw new Error("prompt file path missing");
			expect(readFileSync(promptFilePath, "utf8")).toBe(longPrompt);

			const deleteRes = await manager.deleteProject("p7-delay");
			expect(deleteRes.ok).toBe(true);
		} finally {
			if (priorDelay === undefined) {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = undefined;
			} else {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = priorDelay;
			}
			if (priorCodexFollowupSettle === undefined) {
				process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS = undefined;
			} else {
				process.env.HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS = priorCodexFollowupSettle;
			}
		}
	});

	it("reproduces codex collapsed-paste bug with single-Enter tmux sendInput", async () => {
		simulateCodexCollapsedPasteSubmit = true;
		simulateCodexCollapsedPasteMarkerDelayMs = 350;
		const priorDelay = process.env.HARNESS_INITIAL_TASK_DELAY_MS;
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = "10000";
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		try {
			const projectRes = await manager.createProject("p7b", process.cwd());
			expect(projectRes.ok).toBe(true);
			if (!projectRes.ok) throw new Error("project create failed");

			const createRes = await manager.createAgent("p7b", "codex", "initial task");
			expect(createRes.ok).toBe(true);
			if (!createRes.ok) throw new Error("agent create failed");
			const target = createRes.value.tmuxTarget;
			const [sessionName, windowName] = target.split(":");
			if (!sessionName || !windowName) throw new Error("bad tmux target");
			const session = fake.sessions.get(sessionName);
			const window = session?.windows.get(windowName);
			if (!window) throw new Error("window missing");

			const longPrompt = `Long prompt: ${"bug ".repeat(2800)}`;
			const inputRes = await tmux.sendInput(target, longPrompt);
			expect(inputRes.ok).toBe(true);
			expect(window.enterKeyCount).toBeGreaterThanOrEqual(1);
			expect(window.submitCount).toBe(0);
			expect(window.pendingCollapsedPasteSubmit).toBe(true);

			const deleteRes = await manager.deleteProject("p7b");
			expect(deleteRes.ok).toBe(true);
		} finally {
			if (priorDelay === undefined) {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = undefined;
			} else {
				process.env.HARNESS_INITIAL_TASK_DELAY_MS = priorDelay;
			}
		}
	});

	it("codex long initial task is staged and referenced in startup command", async () => {
		simulateCodexCollapsedPasteSubmit = true;
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("p8", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const longTask = `Long prompt: ${"xyz ".repeat(280)}`;
		const createRes = await manager.createAgent("p8", "codex", longTask);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		const target = createRes.value.tmuxTarget;
		const [sessionName, windowName] = target.split(":");
		if (!sessionName || !windowName) throw new Error("bad tmux target");
		const session = fake.sessions.get(sessionName);
		const window = session?.windows.get(windowName);
		if (!window) throw new Error("window missing");
		expect(window.startCommand).toContain("read my instructions in file:");
		const promptFilePath = extractPromptFilePath(window.startCommand);
		expect(promptFilePath).not.toBeNull();
		if (!promptFilePath) throw new Error("prompt file path missing");
		expect(readFileSync(promptFilePath, "utf8")).toBe(longTask);
		expect(window.submitCount).toBe(0);
		expect(window.pendingCollapsedPasteSubmit).toBe(false);

		const deleteRes = await manager.deleteProject("p8");
		expect(deleteRes.ok).toBe(true);
	});

	it("codex initial startup command is stable even with delayed collapsed-marker simulation", async () => {
		simulateCodexCollapsedPasteSubmit = true;
		simulateCodexCollapsedPasteMarkerDelayMs = 350;
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("p8-delay", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const longTask = `Long delayed initial: ${"xyz ".repeat(280)}`;
		const createRes = await manager.createAgent("p8-delay", "codex", longTask);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		const target = createRes.value.tmuxTarget;
		const [sessionName, windowName] = target.split(":");
		if (!sessionName || !windowName) throw new Error("bad tmux target");
		const session = fake.sessions.get(sessionName);
		const window = session?.windows.get(windowName);
		if (!window) throw new Error("window missing");
		expect(window.startCommand).toContain("read my instructions in file:");
		const promptFilePath = extractPromptFilePath(window.startCommand);
		expect(promptFilePath).not.toBeNull();
		if (!promptFilePath) throw new Error("prompt file path missing");
		expect(readFileSync(promptFilePath, "utf8")).toBe(longTask);
		expect(window.submitCount).toBe(0);
		expect(window.pendingCollapsedPasteSubmit).toBe(false);

		const deleteRes = await manager.deleteProject("p8-delay");
		expect(deleteRes.ok).toBe(true);
	});
});

describe("session/manager.terminal-state", () => {
	it("reactivates a quiesced agent on successful sendInput and clears persisted terminal state", async () => {
		const logDir = await makeTempDir("ah-terminal-reactivate-");
		const config = makeConfig();
		config.logDir = logDir;
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(config, store, eventBus);

		const projectRes = await manager.createProject("pt-reactivate", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent(
			"pt-reactivate",
			"codex",
			"Reply with exactly: 4",
			undefined,
			undefined,
			undefined,
			"codex-reactivate-1",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");

		const agent = createRes.value;
		agent.status = "idle";
		agent.pollState = "quiesced";
		agent.terminalStatus = "idle";
		agent.terminalObservedAt = "2026-02-18T09:59:58.000Z";
		agent.terminalQuietSince = "2026-02-18T09:59:59.000Z";
		agent.finalizedAt = "2026-02-18T10:00:00.000Z";
		agent.finalMessage = "final answer";
		agent.finalMessageSource = "internals_codex_jsonl";
		agent.deliveryState = "sent";
		agent.deliveryInFlight = false;
		agent.deliveryId = "delivery-reactivate";
		agent.deliverySentAt = "2026-02-18T10:00:01.000Z";
		await manager.persistAgentTerminalState(agent.project, agent.id);

		const sendRes = await manager.sendInput("pt-reactivate", agent.id, "follow-up prompt");
		expect(sendRes.ok).toBe(true);

		const updatedRes = manager.getAgent("pt-reactivate", agent.id);
		expect(updatedRes.ok).toBe(true);
		if (!updatedRes.ok) throw new Error("agent missing after reactivation");
		expect(updatedRes.value.status).toBe("processing");
		expect(updatedRes.value.pollState).toBe("active");
		expect(updatedRes.value.terminalStatus).toBeNull();
		expect(updatedRes.value.finalizedAt).toBeNull();
		expect(updatedRes.value.deliveryState).toBe("not_applicable");
		expect(updatedRes.value.deliveryId).toBeNull();

		const terminalState = await readPersistedTerminalState(logDir);
		expect(terminalState["pt-reactivate:codex-reactivate-1"]).toBeUndefined();
	});

	it("rejects sendInput for a quiesced dead pane and preserves terminal snapshot", async () => {
		const logDir = await makeTempDir("ah-terminal-dead-pane-");
		const config = makeConfig();
		config.logDir = logDir;
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(config, store, eventBus);

		const projectRes = await manager.createProject("pt-dead", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent(
			"pt-dead",
			"codex",
			"Reply with exactly: 4",
			undefined,
			undefined,
			undefined,
			"codex-dead-pane-1",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");

		const agent = createRes.value;
		agent.status = "idle";
		agent.pollState = "quiesced";
		agent.terminalStatus = "idle";
		agent.terminalObservedAt = "2026-02-18T09:59:58.000Z";
		agent.terminalQuietSince = "2026-02-18T09:59:59.000Z";
		agent.finalizedAt = "2026-02-18T10:00:00.000Z";
		agent.finalMessage = "final answer";
		agent.finalMessageSource = "internals_codex_jsonl";
		agent.deliveryState = "sent";
		agent.deliveryInFlight = false;
		agent.deliveryId = "delivery-dead-pane";
		agent.deliverySentAt = "2026-02-18T10:00:01.000Z";
		await manager.persistAgentTerminalState(agent.project, agent.id);

		const session = fake.sessions.get("ah-manager-test-pt-dead");
		const window = session?.windows.get("codex-dead-pane-1");
		if (!window) throw new Error("window missing");
		window.paneDead = true;

		const sendRes = await manager.sendInput("pt-dead", agent.id, "follow-up prompt");
		expect(sendRes.ok).toBe(false);
		if (sendRes.ok) throw new Error("expected sendInput failure");
		expect(sendRes.error.code).toBe("TMUX_ERROR");

		const updatedRes = manager.getAgent("pt-dead", agent.id);
		expect(updatedRes.ok).toBe(true);
		if (!updatedRes.ok) throw new Error("agent missing after dead-pane sendInput");
		expect(updatedRes.value.status).toBe("exited");
		expect(updatedRes.value.pollState).toBe("quiesced");
		expect(updatedRes.value.terminalStatus).toBe("idle");
		expect(updatedRes.value.finalizedAt).toBe("2026-02-18T10:00:00.000Z");
		expect(updatedRes.value.deliveryId).toBe("delivery-dead-pane");
	});

	it("rehydrates persisted quiesced state and clears stale in-flight delivery markers", async () => {
		const logDir = await makeTempDir("ah-terminal-rehydrate-");
		const config = makeConfig();
		config.logDir = logDir;

		const store1 = createStore();
		const eventBus1 = createEventBus(500);
		const manager1 = createManager(config, store1, eventBus1);

		const projectRes = await manager1.createProject("pt-rehydrate", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager1.createAgent(
			"pt-rehydrate",
			"codex",
			"Reply with exactly: 4",
			undefined,
			undefined,
			undefined,
			"codex-rehydrate-1",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");

		const agent = createRes.value;
		agent.status = "idle";
		agent.pollState = "quiesced";
		agent.terminalStatus = "idle";
		agent.terminalObservedAt = "2026-02-18T09:59:58.000Z";
		agent.terminalQuietSince = "2026-02-18T09:59:59.000Z";
		agent.finalizedAt = "2026-02-18T10:00:00.000Z";
		agent.finalMessage = "final answer";
		agent.finalMessageSource = "internals_codex_jsonl";
		agent.deliveryState = "pending";
		agent.deliveryInFlight = true;
		agent.deliveryId = "delivery-rehydrate";
		agent.deliverySentAt = null;
		await manager1.persistAgentTerminalState(agent.project, agent.id);

		const store2 = createStore();
		const eventBus2 = createEventBus(500);
		const manager2 = createManager(config, store2, eventBus2);
		await manager2.rehydrateProjectsFromTmux();
		await manager2.rehydrateAgentsFromTmux();

		const recoveredRes = manager2.getAgent("pt-rehydrate", "codex-rehydrate-1");
		expect(recoveredRes.ok).toBe(true);
		if (!recoveredRes.ok) throw new Error("rehydrated agent missing");
		expect(recoveredRes.value.pollState).toBe("quiesced");
		expect(recoveredRes.value.terminalStatus).toBe("idle");
		expect(recoveredRes.value.deliveryState).toBe("pending");
		expect(recoveredRes.value.deliveryInFlight).toBe(false);
		expect(recoveredRes.value.finalMessage).toBe("final answer");

		const terminalState = await readPersistedTerminalState(logDir);
		expect(terminalState["pt-rehydrate:codex-rehydrate-1"]).toEqual(
			expect.objectContaining({
				deliveryInFlight: false,
				deliveryState: "pending",
			}),
		);
	});
});

describe("session/manager.subscriptions", () => {
	it("inherits project callback defaults when agent callback is omitted", async () => {
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("pc-defaults", process.cwd(), {
			url: "https://receiver.test/harness-webhook",
			token: "project-token",
			discordChannel: "project-alerts",
			sessionKey: "project-session",
		});
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent("pc-defaults", "codex", "Reply with exactly: 4");
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		expect(createRes.value.callback).toEqual({
			url: "https://receiver.test/harness-webhook",
			token: "project-token",
			discordChannel: "project-alerts",
			sessionKey: "project-session",
		});
	});

	it("prefers explicit agent callback over project callback defaults", async () => {
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("pc-explicit", process.cwd(), {
			url: "https://receiver.test/project-default",
			token: "project-token",
			discordChannel: "project-alerts",
			sessionKey: "project-session",
		});
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent(
			"pc-explicit",
			"codex",
			"Reply with exactly: 4",
			undefined,
			undefined,
			{
				url: "https://receiver.test/agent-explicit",
				token: "agent-token",
				discordChannel: "agent-alerts",
				sessionKey: "agent-session",
			},
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		expect(createRes.value.callback).toEqual({
			url: "https://receiver.test/agent-explicit",
			token: "agent-token",
			discordChannel: "agent-alerts",
			sessionKey: "agent-session",
		});
	});

	it("updates persisted project callback defaults", async () => {
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("pc-update", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const updateRes = await manager.updateProject("pc-update", {
			cwd: "/tmp/pc-update-new",
			callback: {
				url: "https://receiver.test/updated-default",
				token: "updated-token",
				discordChannel: "updated-alerts",
				sessionKey: "updated-session",
			},
		});
		expect(updateRes.ok).toBe(true);
		if (!updateRes.ok) throw new Error("project update failed");
		expect(updateRes.value.cwd).toBe("/tmp/pc-update-new");
		expect(updateRes.value.callback).toEqual({
			url: "https://receiver.test/updated-default",
			token: "updated-token",
			discordChannel: "updated-alerts",
			sessionKey: "updated-session",
		});
	});

	it("persists per-agent callback routing", async () => {
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("pc1", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent(
			"pc1",
			"codex",
			"Reply with exactly: 4",
			undefined,
			undefined,
			{
				url: "https://receiver.test/harness-webhook",
				token: "callback-token",
				discordChannel: "alerts",
				sessionKey: "session-main",
				extra: { requestId: "req-1" },
			},
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		expect(createRes.value.callback).toEqual({
			url: "https://receiver.test/harness-webhook",
			token: "callback-token",
			discordChannel: "alerts",
			sessionKey: "session-main",
			extra: { requestId: "req-1" },
		});
	});

	it("rehydrates project and agent callbacks across manager restart", async () => {
		const logDir = await makeTempDir("ah-callback-rehydrate-");
		const config = makeConfig();
		config.logDir = logDir;

		const store1 = createStore();
		const eventBus1 = createEventBus(500);
		const manager1 = createManager(config, store1, eventBus1);

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
			extra: { requestId: "req-77" },
		};

		const createProjectRes = await manager1.createProject(
			"pc-rehydrate",
			process.cwd(),
			projectCallback,
		);
		expect(createProjectRes.ok).toBe(true);
		if (!createProjectRes.ok) throw new Error("project create failed");

		const inheritedRes = await manager1.createAgent(
			"pc-rehydrate",
			"codex",
			"Reply with exactly: inherited",
			undefined,
			undefined,
			undefined,
			"codex-inherited-callback",
		);
		expect(inheritedRes.ok).toBe(true);
		if (!inheritedRes.ok) throw new Error("inherited agent create failed");

		const explicitRes = await manager1.createAgent(
			"pc-rehydrate",
			"claude-code",
			"Reply with exactly: explicit",
			undefined,
			undefined,
			agentCallback,
			"claude-explicit-callback",
		);
		expect(explicitRes.ok).toBe(true);
		if (!explicitRes.ok) throw new Error("explicit agent create failed");

		const store2 = createStore();
		const eventBus2 = createEventBus(500);
		const manager2 = createManager(config, store2, eventBus2);
		await manager2.rehydrateProjectsFromTmux();
		await manager2.rehydrateAgentsFromTmux();

		const projectRes = manager2.getProject("pc-rehydrate");
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project rehydrate failed");
		expect(projectRes.value.callback).toEqual(projectCallback);

		const agentsRes = manager2.listAgents("pc-rehydrate");
		expect(agentsRes.ok).toBe(true);
		if (!agentsRes.ok) throw new Error("agent list failed");
		const inherited = agentsRes.value.find((agent) => agent.id === "codex-inherited-callback");
		const explicit = agentsRes.value.find((agent) => agent.id === "claude-explicit-callback");
		expect(inherited?.callback).toEqual(projectCallback);
		expect(explicit?.callback).toEqual(agentCallback);
	});

	it("removes persisted callback state when agent/project are deleted", async () => {
		const logDir = await makeTempDir("ah-callback-prune-");
		const config = makeConfig();
		config.logDir = logDir;
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(config, store, eventBus);

		const createProjectRes = await manager.createProject("pc-persist-delete", process.cwd(), {
			url: "https://receiver.test/project-delete",
			token: "project-delete-token",
		});
		expect(createProjectRes.ok).toBe(true);
		if (!createProjectRes.ok) throw new Error("project create failed");

		const createAgentRes = await manager.createAgent(
			"pc-persist-delete",
			"codex",
			"Reply with exactly: delete-state",
			undefined,
			undefined,
			{
				url: "https://receiver.test/agent-delete",
				token: "agent-delete-token",
			},
			"codex-persist-delete",
		);
		expect(createAgentRes.ok).toBe(true);
		if (!createAgentRes.ok) throw new Error("agent create failed");

		const beforeDelete = await readPersistedCallbackState(logDir);
		expect(beforeDelete.projects["pc-persist-delete"]).toBeDefined();
		expect(beforeDelete.agents["pc-persist-delete:codex-persist-delete"]).toBeDefined();

		const deleteAgentRes = await manager.deleteAgent("pc-persist-delete", "codex-persist-delete");
		expect(deleteAgentRes.ok).toBe(true);
		if (!deleteAgentRes.ok) throw new Error("agent delete failed");

		const afterAgentDelete = await readPersistedCallbackState(logDir);
		expect(afterAgentDelete.projects["pc-persist-delete"]).toBeDefined();
		expect(afterAgentDelete.agents["pc-persist-delete:codex-persist-delete"]).toBeUndefined();

		const deleteProjectRes = await manager.deleteProject("pc-persist-delete");
		expect(deleteProjectRes.ok).toBe(true);
		if (!deleteProjectRes.ok) throw new Error("project delete failed");

		const afterProjectDelete = await readPersistedCallbackState(logDir);
		expect(afterProjectDelete.projects["pc-persist-delete"]).toBeUndefined();
		expect(afterProjectDelete.agents["pc-persist-delete:codex-persist-delete"]).toBeUndefined();
	});

	it("rejects unknown subscription id", async () => {
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("ps1", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent(
			"ps1",
			"codex",
			"Reply with exactly: 4",
			undefined,
			"missing-sub",
		);
		expect(createRes.ok).toBe(false);
		if (createRes.ok) throw new Error("expected failure");
		expect(createRes.error.code).toBe("SUBSCRIPTION_NOT_FOUND");
	});

	it("uses claude sourceDir directly and sets subscriptionId on agent", async () => {
		const sourceDir = await makeTempDir("ah-sub-claude-src-");
		await Bun.write(
			join(sourceDir, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: "sk-ant-oat01-test",
					scopes: ["user:inference"],
				},
			}),
		);

		const config = makeConfig();
		config.subscriptions = {
			"claude-sub": {
				provider: "claude-code",
				mode: "oauth",
				sourceDir,
			},
		};
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(config, store, eventBus);

		const projectRes = await manager.createProject("ps2", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent(
			"ps2",
			"claude-code",
			"Reply with exactly: 4",
			undefined,
			"claude-sub",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		expect(createRes.value.subscriptionId).toBe("claude-sub");
		expect(createRes.value.providerRuntimeDir).toBe(sourceDir);
	});

	it("supports claude tokenFile subscriptions without materializing runtime credentials", async () => {
		const sourceDir = await makeTempDir("ah-sub-claude-token-");
		const tokenFile = join(sourceDir, "cloudgeni.token");
		await Bun.write(tokenFile, "sk-ant-oat01-cloudgeni\n");

		const config = makeConfig();
		config.subscriptions = {
			"claude-token-sub": {
				provider: "claude-code",
				mode: "oauth",
				tokenFile,
			},
		};
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(config, store, eventBus);

		const projectRes = await manager.createProject("ps2b", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent(
			"ps2b",
			"claude-code",
			"Reply with exactly: 4",
			undefined,
			"claude-token-sub",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		expect(createRes.value.subscriptionId).toBe("claude-token-sub");
		expect(createRes.value.providerRuntimeDir).toBeUndefined();
	});

	it("discovers codex subscriptions and allows selecting discovered id", async () => {
		const discoveredDir = await makeTempDir("ah-sub-codex-discovered-");
		await Bun.write(
			join(discoveredDir, "auth.json"),
			JSON.stringify({
				tokens: {
					id_token: "id-token",
					access_token: "access-token",
					refresh_token: "refresh-token",
					account_id: "acct-discovered",
				},
				last_refresh: "2026-02-18T00:00:00Z",
			}),
		);

		const config = makeConfig();
		config.subscriptionDiscovery = {
			enabled: true,
			includeDefaults: false,
			claudeDirs: [],
			claudeTokenFiles: [],
			codexDirs: [discoveredDir],
		};
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(config, store, eventBus);

		const projectRes = await manager.createProject("ps3", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const subscriptions = await manager.listSubscriptions();
		expect(subscriptions).toHaveLength(1);
		expect(subscriptions[0]?.source).toBe("discovered");
		const discoveredId = subscriptions[0]?.id;
		if (!discoveredId) throw new Error("missing discovered subscription id");

		const createRes = await manager.createAgent(
			"ps3",
			"codex",
			"Reply with exactly: 4",
			undefined,
			discoveredId,
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		expect(createRes.value.subscriptionId).toBe(discoveredId);
	});
});

describe("session/manager.rehydrate", () => {
	it("rehydrates codex agents from existing tmux sessions/windows and is idempotent", async () => {
		const config = makeConfig();
		const sourceStore = createStore();
		const sourceBus = createEventBus(500);
		const sourceManager = createManager(config, sourceStore, sourceBus);

		const projectRes = await sourceManager.createProject("pr1", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await sourceManager.createAgent(
			"pr1",
			"codex",
			"Reply with exactly: 4",
			undefined,
			undefined,
			undefined,
			"agent-reattach-1",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");

		const recoveredStore = createStore();
		const recoveredBus = createEventBus(500);
		const recoveredManager = createManager(config, recoveredStore, recoveredBus);

		await recoveredManager.rehydrateProjectsFromTmux();
		await recoveredManager.rehydrateAgentsFromTmux();
		await recoveredManager.rehydrateAgentsFromTmux();

		const recoveredProject = recoveredManager.getProject("pr1");
		expect(recoveredProject.ok).toBe(true);
		if (!recoveredProject.ok) throw new Error("project missing after rehydrate");

		const recoveredAgents = recoveredManager.listAgents("pr1");
		expect(recoveredAgents.ok).toBe(true);
		if (!recoveredAgents.ok) throw new Error("agents missing after rehydrate");
		expect(recoveredAgents.value).toHaveLength(1);
		expect(recoveredAgents.value[0]?.id).toBe("agent-reattach-1");
		expect(recoveredAgents.value[0]?.provider).toBe("codex");
		expect(recoveredAgents.value[0]?.tmuxTarget).toBe("ah-manager-test-pr1:agent-reattach-1");
		expect(recoveredAgents.value[0]?.attachCommand).toContain("ah-manager-test-pr1");
		expect(recoveredAgents.value[0]?.status).toBe("idle");
		expect(recoveredAgents.value[0]?.lastCapturedOutput).toContain(">");
		expect(recoveredAgents.value[0]?.providerRuntimeDir).toContain("/codex/pr1/agent-reattach-1");
	});

	it("rehydrates claude agents and restores provider session file path", async () => {
		const sourceStore = createStore();
		const sourceBus = createEventBus(500);
		const sourceManager = createManager(makeConfig(), sourceStore, sourceBus);

		const projectRes = await sourceManager.createProject("pr-claude", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await sourceManager.createAgent(
			"pr-claude",
			"claude-code",
			"Reply with exactly: 4",
			undefined,
			undefined,
			undefined,
			"claude-reattach-1",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		expect(createRes.value.providerSessionFile).toBeDefined();

		const recoveredStore = createStore();
		const recoveredBus = createEventBus(500);
		const recoveredManager = createManager(makeConfig(), recoveredStore, recoveredBus);

		await recoveredManager.rehydrateProjectsFromTmux();
		await recoveredManager.rehydrateAgentsFromTmux();

		const recoveredAgents = recoveredManager.listAgents("pr-claude");
		expect(recoveredAgents.ok).toBe(true);
		if (!recoveredAgents.ok) throw new Error("agents missing after rehydrate");
		expect(recoveredAgents.value).toHaveLength(1);
		expect(recoveredAgents.value[0]?.id).toBe("claude-reattach-1");
		expect(recoveredAgents.value[0]?.provider).toBe("claude-code");
		expect(recoveredAgents.value[0]?.providerSessionFile).toBe(createRes.value.providerSessionFile);
	});

	it("rehydrates dead panes as exited", async () => {
		const sourceStore = createStore();
		const sourceBus = createEventBus(500);
		const sourceManager = createManager(makeConfig(), sourceStore, sourceBus);

		const projectRes = await sourceManager.createProject("pr-dead", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await sourceManager.createAgent(
			"pr-dead",
			"codex",
			"Reply with exactly: 4",
			undefined,
			undefined,
			undefined,
			"dead-pane-1",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");

		const session = fake.sessions.get("ah-manager-test-pr-dead");
		const window = session?.windows.get("dead-pane-1");
		if (!window) throw new Error("window missing");
		window.paneDead = true;

		const recoveredStore = createStore();
		const recoveredBus = createEventBus(500);
		const recoveredManager = createManager(makeConfig(), recoveredStore, recoveredBus);

		await recoveredManager.rehydrateProjectsFromTmux();
		await recoveredManager.rehydrateAgentsFromTmux();

		const recoveredAgents = recoveredManager.listAgents("pr-dead");
		expect(recoveredAgents.ok).toBe(true);
		if (!recoveredAgents.ok) throw new Error("agents missing after rehydrate");
		expect(recoveredAgents.value).toHaveLength(1);
		expect(recoveredAgents.value[0]?.status).toBe("exited");
	});

	it("skips windows when provider cannot be inferred", async () => {
		const sourceStore = createStore();
		const sourceBus = createEventBus(500);
		const sourceManager = createManager(makeConfig(), sourceStore, sourceBus);

		const projectRes = await sourceManager.createProject("pr-skip", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const sessionName = "ah-manager-test-pr-skip";
		const manualWindow = await tmux.createWindow(sessionName, "agent-unknown-1", process.cwd(), [
			"mystery-cli",
		]);
		expect(manualWindow.ok).toBe(true);
		if (!manualWindow.ok) throw new Error("manual tmux window create failed");

		const recoveredStore = createStore();
		const recoveredBus = createEventBus(500);
		const recoveredManager = createManager(makeConfig(), recoveredStore, recoveredBus);

		await recoveredManager.rehydrateProjectsFromTmux();
		await recoveredManager.rehydrateAgentsFromTmux();

		const recoveredAgents = recoveredManager.listAgents("pr-skip");
		expect(recoveredAgents.ok).toBe(true);
		if (!recoveredAgents.ok) throw new Error("agents missing after rehydrate");
		expect(recoveredAgents.value).toHaveLength(0);
	});

	it("rehydrates quiesced terminal state from persisted snapshot", async () => {
		const logDir = await makeTempDir("ah-terminal-rehydrate-");
		const config = makeConfig(logDir);
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(config, store, eventBus);

		const projectRes = await manager.createProject("pr-quiesced", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent(
			"pr-quiesced",
			"codex",
			"initial task",
			undefined,
			undefined,
			undefined,
			"quiesced-1",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");

		const persisted = store.getAgent("pr-quiesced", "quiesced-1");
		if (!persisted) throw new Error("agent missing from store");
		persisted.status = "idle";
		persisted.pollState = "quiesced";
		persisted.terminalStatus = "idle";
		persisted.terminalObservedAt = "2026-02-18T09:59:58.000Z";
		persisted.terminalQuietSince = "2026-02-18T09:59:59.000Z";
		persisted.finalizedAt = "2026-02-18T10:00:00.000Z";
		persisted.finalMessage = "done";
		persisted.finalMessageSource = "internals_codex_jsonl";
		persisted.deliveryState = "pending";
		persisted.deliveryId = "delivery-quiesced-1";
		await manager.persistAgentTerminalState("pr-quiesced", "quiesced-1");

		const recoveredStore = createStore();
		const recoveredBus = createEventBus(500);
		const recoveredManager = createManager(config, recoveredStore, recoveredBus);
		await recoveredManager.rehydrateProjectsFromTmux();
		await recoveredManager.rehydrateAgentsFromTmux();

		const recovered = recoveredManager.getAgent("pr-quiesced", "quiesced-1");
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) throw new Error("rehydrated agent missing");
		expect(recovered.value.status).toBe("idle");
		expect(recovered.value.pollState).toBe("quiesced");
		expect(recovered.value.terminalStatus).toBe("idle");
		expect(recovered.value.finalizedAt).toBe("2026-02-18T10:00:00.000Z");
		expect(recovered.value.finalMessage).toBe("done");
		expect(recovered.value.deliveryState).toBe("pending");
	});
});

describe("session/manager.quiesced-reactivation", () => {
	it("reactivates a quiesced live agent on successful sendInput", async () => {
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("pq-reactivate", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent(
			"pq-reactivate",
			"codex",
			"initial task",
			undefined,
			undefined,
			undefined,
			"quiesced-live-1",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");

		const agent = store.getAgent("pq-reactivate", "quiesced-live-1");
		if (!agent) throw new Error("agent missing");
		agent.status = "idle";
		agent.pollState = "quiesced";
		agent.terminalStatus = "idle";
		agent.terminalObservedAt = "2026-02-18T09:59:58.000Z";
		agent.terminalQuietSince = "2026-02-18T09:59:59.000Z";
		agent.finalizedAt = "2026-02-18T10:00:00.000Z";
		agent.finalMessage = "done";
		agent.finalMessageSource = "internals_codex_jsonl";
		agent.deliveryState = "pending";
		agent.deliveryId = "delivery-live-1";
		await manager.persistAgentTerminalState("pq-reactivate", "quiesced-live-1");

		const sendRes = await manager.sendInput("pq-reactivate", "quiesced-live-1", "follow-up prompt");
		expect(sendRes.ok).toBe(true);
		if (!sendRes.ok) throw new Error("sendInput failed");

		const after = manager.getAgent("pq-reactivate", "quiesced-live-1");
		expect(after.ok).toBe(true);
		if (!after.ok) throw new Error("agent missing after sendInput");
		expect(after.value.status).toBe("processing");
		expect(after.value.pollState).toBe("active");
		expect(after.value.terminalStatus).toBeNull();
		expect(after.value.finalizedAt).toBeNull();
		expect(after.value.deliveryState).toBe("not_applicable");
		expect(after.value.deliveryId).toBeNull();
	});

	it("rejects sendInput for quiesced dead panes and preserves terminal metadata", async () => {
		const seen: NormalizedEvent[] = [];
		const store = createStore();
		const eventBus = createEventBus(500);
		eventBus.subscribe({ project: "pq-dead" }, (event) => seen.push(event));
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("pq-dead", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent(
			"pq-dead",
			"codex",
			"initial task",
			undefined,
			undefined,
			undefined,
			"quiesced-dead-1",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");

		const agent = store.getAgent("pq-dead", "quiesced-dead-1");
		if (!agent) throw new Error("agent missing");
		agent.status = "idle";
		agent.pollState = "quiesced";
		agent.terminalStatus = "idle";
		agent.terminalObservedAt = "2026-02-18T09:59:58.000Z";
		agent.finalizedAt = "2026-02-18T10:00:00.000Z";
		agent.finalMessage = "done";
		agent.finalMessageSource = "internals_codex_jsonl";
		agent.deliveryState = "pending";
		agent.deliveryId = "delivery-dead-1";
		await manager.persistAgentTerminalState("pq-dead", "quiesced-dead-1");

		const [sessionName, windowName] = agent.tmuxTarget.split(":");
		if (!sessionName || !windowName) throw new Error("bad tmux target");
		const session = fake.sessions.get(sessionName);
		const window = session?.windows.get(windowName);
		if (!window) throw new Error("window missing");
		window.paneDead = true;

		const sendRes = await manager.sendInput("pq-dead", "quiesced-dead-1", "should fail");
		expect(sendRes.ok).toBe(false);
		if (sendRes.ok) throw new Error("sendInput unexpectedly succeeded");
		expect(sendRes.error.code).toBe("TMUX_ERROR");

		const after = manager.getAgent("pq-dead", "quiesced-dead-1");
		expect(after.ok).toBe(true);
		if (!after.ok) throw new Error("agent missing after failed sendInput");
		expect(after.value.status).toBe("exited");
		expect(after.value.pollState).toBe("quiesced");
		expect(after.value.terminalStatus).toBe("idle");
		expect(after.value.finalizedAt).toBe("2026-02-18T10:00:00.000Z");
		expect(after.value.deliveryState).toBe("pending");
		expect(after.value.deliveryId).toBe("delivery-dead-1");
		expect(
			seen.some(
				(event) =>
					event.type === "status_changed" &&
					event.agentId === "quiesced-dead-1" &&
					event.to === "exited" &&
					event.source === "manager_send_input_preflight",
			),
		).toBe(true);
	});
});

describe("session/manager.agent-names", () => {
	it("uses provided name as id/window and validates format", async () => {
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("pn1", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const createRes = await manager.createAgent(
			"pn1",
			"codex",
			"Reply with exactly: 4",
			undefined,
			undefined,
			undefined,
			"codex-bright-fox",
		);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		expect(createRes.value.id).toBe("codex-bright-fox");
		expect(createRes.value.windowName).toBe("codex-bright-fox");
		expect(createRes.value.tmuxTarget).toContain(":codex-bright-fox");

		const invalidRes = await manager.createAgent(
			"pn1",
			"codex",
			"Reply with exactly: 4",
			undefined,
			undefined,
			undefined,
			"Bad Name",
		);
		expect(invalidRes.ok).toBe(false);
		if (invalidRes.ok) throw new Error("expected failure");
		expect(invalidRes.error.code).toBe("AGENT_NAME_INVALID");
	});

	it("auto-generates provider-adjective-noun ids and enforces project-local uniqueness", async () => {
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const p1Res = await manager.createProject("pn2-a", process.cwd());
		expect(p1Res.ok).toBe(true);
		if (!p1Res.ok) throw new Error("project create failed");
		const p2Res = await manager.createProject("pn2-b", process.cwd());
		expect(p2Res.ok).toBe(true);
		if (!p2Res.ok) throw new Error("project create failed");

		const autoRes = await manager.createAgent("pn2-a", "codex", "Reply with exactly: 4");
		expect(autoRes.ok).toBe(true);
		if (!autoRes.ok) throw new Error("agent create failed");
		expect(autoRes.value.id).toMatch(/^codex-[a-z]{3,8}-[a-z]{3,8}$/);
		expect(autoRes.value.windowName).toBe(autoRes.value.id);

		const namedA = await manager.createAgent(
			"pn2-a",
			"codex",
			"Reply with exactly: 4",
			undefined,
			undefined,
			undefined,
			"codex-same-otter",
		);
		expect(namedA.ok).toBe(true);
		if (!namedA.ok) throw new Error("agent create failed");

		const namedConflict = await manager.createAgent(
			"pn2-a",
			"codex",
			"Reply with exactly: 4",
			undefined,
			undefined,
			undefined,
			"codex-same-otter",
		);
		expect(namedConflict.ok).toBe(false);
		if (namedConflict.ok) throw new Error("expected failure");
		expect(namedConflict.error.code).toBe("NAME_CONFLICT");

		const namedOtherProject = await manager.createAgent(
			"pn2-b",
			"codex",
			"Reply with exactly: 4",
			undefined,
			undefined,
			undefined,
			"codex-same-otter",
		);
		expect(namedOtherProject.ok).toBe(true);
	});
});
