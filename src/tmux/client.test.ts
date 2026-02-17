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
let state: SpawnState;

beforeEach(() => {
	state = {
		calls: [],
		stdoutByCall: [],
		exitCodeByCall: [],
	};

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
});

afterEach(() => {
	(Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
});

describe("tmux/client.command-shape", () => {
	it("builds expected tmux argv across exported operations", async () => {
		await createSession("ah-p", "/tmp/proj");
		await createWindow("ah-p", "codex-a1", "/tmp/proj", ["codex", "--model", "nano"], {
			A: "1",
		});
		await sendInput("ah-p:1.0", "hello");
		await sendKeys("ah-p:1.0", "C-c");
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

		expect(state.calls[0]).toEqual([
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
		expect(state.calls[1]).toEqual(["tmux", "set-option", "-t", "ah-p", "remain-on-exit", "on"]);
		expect(state.calls[2]).toEqual(["tmux", "set-environment", "-t", "ah-p", "A", "1"]);
		expect(state.calls[3]).toEqual([
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
			"codex --model nano",
		]);

		expect(state.calls[4]?.slice(0, 3)).toEqual(["tmux", "load-buffer", expect.any(String)]);
		expect(state.calls[5]).toEqual(["tmux", "paste-buffer", "-t", "ah-p:1.0", "-d", "-p"]);
		expect(state.calls[6]).toEqual(["tmux", "send-keys", "-t", "ah-p:1.0", "C-c"]);
		expect(state.calls[7]).toEqual(["tmux", "capture-pane", "-t", "ah-p:1.0", "-p", "-S", "-200"]);
		expect(state.calls[8]).toEqual(["tmux", "pipe-pane", "-t", "ah-p:1.0", "cat >> /tmp/agent.log"]);
		expect(state.calls[9]).toEqual(["tmux", "pipe-pane", "-t", "ah-p:1.0"]);
		expect(state.calls[10]).toEqual(["tmux", "kill-window", "-t", "ah-p:1.0"]);
		expect(state.calls[11]).toEqual(["tmux", "kill-session", "-t", "ah-p"]);
		expect(state.calls[12]).toEqual(["tmux", "has-session", "-t", "ah-p"]);
		expect(state.calls[13]).toEqual([
			"tmux",
			"list-sessions",
			"-F",
			"#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}",
		]);
		expect(state.calls[14]).toEqual([
			"tmux",
			"list-windows",
			"-t",
			"ah-p",
			"-F",
			"#{window_index}\t#{window_name}\t#{window_active}\t#{pane_id}",
		]);
		expect(state.calls[15]).toEqual(["tmux", "display-message", "-t", "ah-p:1.0", "-p", "#{pane_dead}"]);
		expect(state.calls[16]).toEqual(["tmux", "set-environment", "-t", "ah-p", "B", "2"]);
	});
});
