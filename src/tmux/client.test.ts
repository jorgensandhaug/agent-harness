import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	capturePane,
	createSession,
	createWindow,
	getPaneVar,
	hasSession,
	killSession,
	killWindow,
	listSessions,
	listWindows,
	sendInput,
	sendKeys,
	setEnv,
	startPipePane,
	stopPipePane,
} from "./client.ts";

type SpawnState = {
	calls: string[][];
	stdoutByCall: string[];
	exitCodeByCall: number[];
};

const originalSpawn = Bun.spawn;
const originalPasteDelay = process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS;
let state: SpawnState;

function installSpawnMock(): void {
	(Bun as { spawn: typeof Bun.spawn }).spawn = ((cmd: readonly string[]) => {
		state.calls.push([...cmd]);
		const callIdx = state.calls.length - 1;
		const text = state.stdoutByCall[callIdx] ?? "";
		const exitCode = state.exitCodeByCall[callIdx] ?? 0;
		return {
			exited: Promise.resolve(exitCode),
			stdout: new Blob([text]).stream(),
			stderr: new Blob([""]).stream(),
		} as ReturnType<typeof Bun.spawn>;
	}) as typeof Bun.spawn;
}

beforeEach(() => {
	state = {
		calls: [],
		stdoutByCall: [],
		exitCodeByCall: [],
	};

	installSpawnMock();
	process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS = "0";
});

afterEach(() => {
	(Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
	if (originalPasteDelay === undefined) {
		process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS = undefined;
	} else {
		process.env.HARNESS_TMUX_PASTE_ENTER_DELAY_MS = originalPasteDelay;
	}
});

describe("tmux/client.command-shape", () => {
	it("builds expected tmux argv across exported operations", async () => {
		// Avoid cross-file Bun.spawn contention from delayed manager test timers.
		await Bun.sleep(750);
		state.calls = [];
		installSpawnMock();
		await createSession("ah-p", "/tmp/proj");
		await createWindow("ah-p", "codex-a1", "/tmp/proj", ["codex", "--model", "nano"], {
			A: "1",
		});
		await sendKeys("ah-p:1.0", "C-c");
		await sendInput("ah-p:1.0", "hello");
		await capturePane("ah-p:1.0", 200);
		await startPipePane("ah-p:1.0", "/tmp/agent.log");
		await stopPipePane("ah-p:1.0");
		await killWindow("ah-p:1.0");
		await killSession("ah-p");
		await hasSession("ah-p");
		await listSessions("ah");
		await listWindows("ah-p");
		await getPaneVar("ah-p:1.0", "pane_dead");
		await setEnv("ah-p", "B", "2");

		expect(state.calls).toContainEqual([
			"tmux",
			"new-session",
			"-d",
			"-s",
			"ah-p",
			"-c",
			"/tmp/proj",
			"-x",
			"220",
			"-y",
			"50",
		]);
		expect(state.calls).toContainEqual([
			"tmux",
			"set-option",
			"-t",
			"ah-p",
			"remain-on-exit",
			"on",
		]);
		expect(state.calls).toContainEqual(["tmux", "set-option", "-t", "ah-p", "allow-rename", "off"]);
		expect(state.calls).toContainEqual([
			"tmux",
			"set-option",
			"-t",
			"ah-p",
			"automatic-rename",
			"off",
		]);
		expect(state.calls).toContainEqual([
			"tmux",
			"new-window",
			"-t",
			"ah-p",
			"-n",
			"codex-a1",
			"-c",
			"/tmp/proj",
			"-P",
			"-F",
			"#{pane_id}",
			"env A=1 codex --model nano",
		]);

		expect(
			state.calls.some(
				(call) =>
					call[0] === "tmux" &&
					call[1] === "load-buffer" &&
					typeof call[2] === "string" &&
					call[2].length > 0,
			),
		).toBe(true);
		expect(state.calls).toContainEqual(["tmux", "paste-buffer", "-t", "ah-p:1.0", "-d"]);
		expect(state.calls).toContainEqual(["tmux", "send-keys", "-t", "ah-p:1.0", "Enter"]);
		expect(state.calls).toContainEqual(["tmux", "send-keys", "-t", "ah-p:1.0", "C-c"]);
		expect(state.calls).toContainEqual([
			"tmux",
			"capture-pane",
			"-t",
			"ah-p:1.0",
			"-p",
			"-S",
			"-200",
		]);
		expect(state.calls).toContainEqual([
			"tmux",
			"pipe-pane",
			"-t",
			"ah-p:1.0",
			"cat >> /tmp/agent.log",
		]);
		expect(state.calls).toContainEqual(["tmux", "pipe-pane", "-t", "ah-p:1.0"]);
		expect(state.calls).toContainEqual(["tmux", "kill-window", "-t", "ah-p:1.0"]);
		expect(state.calls).toContainEqual(["tmux", "kill-session", "-t", "ah-p"]);
		expect(state.calls).toContainEqual(["tmux", "has-session", "-t", "ah-p"]);
		expect(state.calls).toContainEqual([
			"tmux",
			"list-sessions",
			"-F",
			"#{session_name}\t#{session_path}\t#{session_windows}\t#{session_created}\t#{session_attached}",
		]);
		expect(state.calls).toContainEqual([
			"tmux",
			"list-windows",
			"-t",
			"ah-p",
			"-F",
			"#{window_index}\t#{window_name}\t#{window_active}\t#{pane_id}",
		]);
		expect(state.calls).toContainEqual([
			"tmux",
			"display-message",
			"-t",
			"ah-p:1.0",
			"-p",
			"#{pane_dead}",
		]);
		expect(state.calls).toContainEqual(["tmux", "set-environment", "-t", "ah-p", "B", "2"]);
	});
});
