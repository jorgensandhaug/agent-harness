import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../config.ts";
import { createEventBus } from "../events/bus.ts";
import type { NormalizedEvent } from "../events/types.ts";
import * as tmux from "../tmux/client.ts";
import { createManager } from "./manager.ts";
import { createStore } from "./store.ts";

const originalSpawn = Bun.spawn;
const originalDelay = process.env.HARNESS_INITIAL_TASK_DELAY_MS;
const originalReadyTimeout = process.env.HARNESS_INITIAL_TASK_READY_TIMEOUT_MS;
const originalPasteEnterDelay = process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS;

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
	pasteBuffer: string;
};

const fake: FakeTmuxState = {
	sessions: new Map(),
	nextPaneId: 1,
	pasteBuffer: "",
};
let simulateSlowCodexStartup = false;
let simulateClaudeStartupConfirm = false;
let simulateCodexPasteEnterRace = false;
let simulateCodexCollapsedPasteSubmit = false;
let simulateCodexCollapsedPasteMarkerDelayMs = 0;
const cleanupDirs: string[] = [];

function resetFake(): void {
	fake.sessions.clear();
	fake.nextPaneId = 1;
	fake.pasteBuffer = "";
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

function resolveWindow(target: string): { session: SessionState; windowName: string } | null {
	const [sessionName, windowName] = target.split(":");
	if (!sessionName || !windowName) return null;
	const session = fake.sessions.get(sessionName);
	if (!session) return null;
	return { session, windowName };
}

beforeEach(() => {
	resetFake();
	process.env.HARNESS_INITIAL_TASK_DELAY_MS = "10";
	process.env.HARNESS_INITIAL_TASK_READY_TIMEOUT_MS = "600";
	process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS = "0";
	simulateSlowCodexStartup = false;
	simulateClaudeStartupConfirm = false;
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
					requiresStartupConfirm: simulateClaudeStartupConfirm && provider === "claude",
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
				const path = args[1];
				if (!path) return proc(1, "", "missing path");
				try {
					fake.pasteBuffer = readFileSync(path, "utf8");
					return proc(0);
				} catch {
					return proc(1, "", "load buffer failed");
				}
			}
			case "paste-buffer": {
				const target = arg(args, "-t");
				if (!target) return proc(1, "", "can't find window");
				const resolved = resolveWindow(target);
				if (!resolved) return proc(1, "", "can't find window");
				const window = resolved.session.windows.get(resolved.windowName);
				if (!window) return proc(1, "", "can't find window");
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
					fake.pasteBuffer.length >= 256
				) {
					window.pendingCollapsedPasteSubmit = true;
					window.collapsedPasteChars = fake.pasteBuffer.length;
					window.collapsedPasteMarkerArmedAtMs =
						Date.now() + simulateCodexCollapsedPasteMarkerDelayMs;
					if (simulateCodexCollapsedPasteMarkerDelayMs <= 0) {
						window.collapsedPasteMarkerInjected = true;
						window.buffer += collapsedPasteMarkers(fake.pasteBuffer.length);
					} else {
						window.collapsedPasteMarkerInjected = false;
					}
					return proc(0);
				}
				window.buffer += fake.pasteBuffer;
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
				if (window.requiresStartupConfirm && !window.startupConfirmed) {
					return proc(
						0,
						[
							"Accessing workspace:",
							"",
							"/tmp/fake",
							"",
							"Quick safety check: Is this a project you created or one you trust?",
							"1. Yes, I trust this folder",
							"2. No, exit",
							"",
							"Enter to confirm",
						].join("\n"),
					);
				}
				const ageMs = Date.now() - window.createdAtMs;
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

function makeConfig(): HarnessConfig {
	return {
		port: 0,
		tmuxPrefix: "ah-manager-test",
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

	it("codex submit survives paste-enter race by delaying Enter after paste", async () => {
		simulateCodexPasteEnterRace = true;
		const priorDelay = process.env.HARNESS_INITIAL_TASK_DELAY_MS;
		const priorPasteDelay = process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS;
		process.env.HARNESS_INITIAL_TASK_DELAY_MS = "10000";
		process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS = "120";
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
			if (priorPasteDelay === undefined) {
				process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS = undefined;
			} else {
				process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS = priorPasteDelay;
			}
		}
	});

	it("codex long follow-up waits for collapsed paste bursts then submits", async () => {
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
			expect(window.buffer).toContain("[Pasted Content 9216 chars][Pasted Content 1024 chars]");

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

	it("codex long initial task is passed in startup command (no post-launch paste)", async () => {
		simulateCodexCollapsedPasteSubmit = true;
		const store = createStore();
		const eventBus = createEventBus(500);
		const manager = createManager(makeConfig(), store, eventBus);

		const projectRes = await manager.createProject("p8", process.cwd());
		expect(projectRes.ok).toBe(true);
		if (!projectRes.ok) throw new Error("project create failed");

		const longTask = `Long prompt: ${"xyz ".repeat(220)}`;
		const createRes = await manager.createAgent("p8", "codex", longTask);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		const target = createRes.value.tmuxTarget;
		const [sessionName, windowName] = target.split(":");
		if (!sessionName || !windowName) throw new Error("bad tmux target");
		const session = fake.sessions.get(sessionName);
		const window = session?.windows.get(windowName);
		if (!window) throw new Error("window missing");
		expect(window.startCommand).toContain(longTask);
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

		const longTask = `Long delayed initial: ${"xyz ".repeat(220)}`;
		const createRes = await manager.createAgent("p8-delay", "codex", longTask);
		expect(createRes.ok).toBe(true);
		if (!createRes.ok) throw new Error("agent create failed");
		const target = createRes.value.tmuxTarget;
		const [sessionName, windowName] = target.split(":");
		if (!sessionName || !windowName) throw new Error("bad tmux target");
		const session = fake.sessions.get(sessionName);
		const window = session?.windows.get(windowName);
		if (!window) throw new Error("window missing");
		expect(window.startCommand).toContain(longTask);
		expect(window.submitCount).toBe(0);
		expect(window.pendingCollapsedPasteSubmit).toBe(false);

		const deleteRes = await manager.deleteProject("p8-delay");
		expect(deleteRes.ok).toBe(true);
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

		const updateRes = manager.updateProject("pc-update", {
			callback: {
				url: "https://receiver.test/updated-default",
				token: "updated-token",
				discordChannel: "updated-alerts",
				sessionKey: "updated-session",
			},
		});
		expect(updateRes.ok).toBe(true);
		if (!updateRes.ok) throw new Error("project update failed");
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
		const sourceStore = createStore();
		const sourceBus = createEventBus(500);
		const sourceManager = createManager(makeConfig(), sourceStore, sourceBus);

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
		const recoveredManager = createManager(makeConfig(), recoveredStore, recoveredBus);

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
		expect(recoveredAgents.value[0]?.providerRuntimeDir).toContain(
			"logs/codex/pr1/agent-reattach-1",
		);
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
