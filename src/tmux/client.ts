import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../log.ts";
import { type Result, err, ok } from "../types.ts";
import type { TmuxError, TmuxSessionInfo, TmuxWindowInfo } from "./types.ts";

async function exec(args: readonly string[]): Promise<Result<string, TmuxError>> {
	log.debug("tmux exec", { args });

	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(["tmux", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch {
		return err({ code: "TMUX_NOT_INSTALLED" });
	}

	const exitCode = await proc.exited;
	const stdoutStream = proc.stdout;
	const stderrStream = proc.stderr;
	const stdout =
		stdoutStream && typeof stdoutStream !== "number" ? await new Response(stdoutStream).text() : "";
	const stderr =
		stderrStream && typeof stderrStream !== "number" ? await new Response(stderrStream).text() : "";

	if (exitCode !== 0) {
		const cmd = `tmux ${args.join(" ")}`;

		if (stderr.includes("no server running") || stderr.includes("no current client")) {
			return err({ code: "SESSION_NOT_FOUND", session: "" });
		}
		if (stderr.includes("session not found") || stderr.includes("can't find session")) {
			const sessionMatch = stderr.match(/session[:\s]+(\S+)/);
			return err({ code: "SESSION_NOT_FOUND", session: sessionMatch?.[1] ?? "" });
		}
		if (stderr.includes("window not found") || stderr.includes("can't find window")) {
			return err({ code: "WINDOW_NOT_FOUND", target: args.join(" ") });
		}

		return err({ code: "COMMAND_FAILED", command: cmd, stderr: stderr.trim(), exitCode });
	}

	return ok(stdout);
}

function pasteSettleDelayMs(): number {
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const raw = process.env["HARNESS_TMUX_PASTE_ENTER_DELAY_MS"];
	if (raw !== undefined) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	// Codex CLI can ignore Enter if sent in the same tick as paste-buffer.
	return 120;
}

export async function createSession(name: string, cwd: string): Promise<Result<void, TmuxError>> {
	const result = await exec(["new-session", "-d", "-s", name, "-c", cwd, "-x", "220", "-y", "50"]);
	if (!result.ok) return result;
	// Set defaults for future windows in this session.
	const optResult = await exec(["set-option", "-t", name, "remain-on-exit", "on"]);
	if (!optResult.ok) return optResult;
	// Disable auto window renaming so session:window targets remain stable.
	const allowRenameResult = await exec(["set-option", "-t", name, "allow-rename", "off"]);
	if (!allowRenameResult.ok) return allowRenameResult;
	const autoRenameResult = await exec(["set-option", "-t", name, "automatic-rename", "off"]);
	if (!autoRenameResult.ok) return autoRenameResult;
	return ok(undefined);
}

export async function createWindow(
	session: string,
	name: string,
	cwd: string,
	cmd?: readonly string[],
	env?: Record<string, string>,
	unsetEnv?: readonly string[],
): Promise<Result<string, TmuxError>> {
	const args = ["new-window", "-t", session, "-n", name, "-c", cwd, "-P", "-F", "#{pane_id}"];
	const command = buildWindowCommand(cmd, env, unsetEnv);
	if (command !== null) {
		args.push(command);
	}

	const result = await exec(args);
	if (!result.ok) return result;

	return ok(result.value.trim());
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function buildWindowCommand(
	cmd?: readonly string[],
	env?: Record<string, string>,
	unsetEnv?: readonly string[],
): string | null {
	const hasCmd = Boolean(cmd && cmd.length > 0);
	const envEntries = Object.entries(env ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
	const unsetUnique = Array.from(
		new Set((unsetEnv ?? []).filter((k) => k.trim().length > 0)),
	).sort();
	const hasEnv = envEntries.length > 0;
	const hasUnset = unsetUnique.length > 0;
	if (!hasCmd && !hasEnv && !hasUnset) {
		return null;
	}

	const parts: string[] = [];
	if (hasEnv || hasUnset) {
		parts.push("env");
		for (const key of unsetUnique) {
			parts.push("-u", key);
		}
		for (const [key, value] of envEntries) {
			parts.push(`${key}=${value}`);
		}
	}
	if (hasCmd) {
		parts.push(...(cmd ?? []));
	} else {
		parts.push("sh");
	}

	return parts.map(shellQuote).join(" ");
}

export async function sendInput(target: string, text: string): Promise<Result<void, TmuxError>> {
	// Write text to temp file, load into tmux buffer, paste into target pane, then submit.
	const tempPath = join(tmpdir(), `ah-input-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await Bun.write(tempPath, text);

	try {
		const loadResult = await exec(["load-buffer", tempPath]);
		if (!loadResult.ok) return loadResult;

		// Avoid bracketed paste mode here; some TUIs keep pasted newlines in the editor
		// instead of submitting on Enter when bracketed paste is enabled.
		const pasteResult = await exec(["paste-buffer", "-t", target, "-d"]);
		if (!pasteResult.ok) return pasteResult;

		const settleMs = pasteSettleDelayMs();
		if (settleMs > 0) {
			await Bun.sleep(settleMs);
		}

		const enterResult = await exec(["send-keys", "-t", target, "Enter"]);
		if (!enterResult.ok) return enterResult;

		return ok(undefined);
	} finally {
		try {
			const { unlink } = await import("node:fs/promises");
			await unlink(tempPath);
		} catch (e) {
			log.debug("temp file cleanup failed", {
				path: tempPath,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
}

export async function sendKeys(target: string, keys: string): Promise<Result<void, TmuxError>> {
	const result = await exec(["send-keys", "-t", target, keys]);
	if (!result.ok) return result;
	return ok(undefined);
}

export async function capturePane(
	target: string,
	lines: number,
): Promise<Result<string, TmuxError>> {
	return exec(["capture-pane", "-t", target, "-p", "-S", `-${lines}`]);
}

export async function startPipePane(
	target: string,
	logPath: string,
): Promise<Result<void, TmuxError>> {
	const result = await exec(["pipe-pane", "-t", target, `cat >> ${logPath}`]);
	if (!result.ok) return result;
	return ok(undefined);
}

export async function stopPipePane(target: string): Promise<Result<void, TmuxError>> {
	const result = await exec(["pipe-pane", "-t", target]);
	if (!result.ok) return result;
	return ok(undefined);
}

export async function killWindow(target: string): Promise<Result<void, TmuxError>> {
	const result = await exec(["kill-window", "-t", target]);
	if (!result.ok) return result;
	return ok(undefined);
}

export async function killSession(name: string): Promise<Result<void, TmuxError>> {
	const result = await exec(["kill-session", "-t", name]);
	if (!result.ok) return result;
	return ok(undefined);
}

export async function hasSession(name: string): Promise<boolean> {
	const result = await exec(["has-session", "-t", name]);
	return result.ok;
}

export async function listSessions(
	prefix: string,
): Promise<Result<readonly TmuxSessionInfo[], TmuxError>> {
	const result = await exec([
		"list-sessions",
		"-F",
		"#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}",
	]);

	if (!result.ok) {
		// No server running means no sessions — that's fine
		if (result.error.code === "SESSION_NOT_FOUND") {
			return ok([]);
		}
		if (
			result.error.code === "COMMAND_FAILED" &&
			result.error.stderr.includes("no server running")
		) {
			return ok([]);
		}
		return result;
	}

	const sessions: TmuxSessionInfo[] = [];
	for (const line of result.value.trim().split("\n")) {
		if (!line) continue;
		const parts = line.split("\t");
		const name = parts[0];
		if (!name || !name.startsWith(`${prefix}-`)) continue;
		sessions.push({
			name,
			windowCount: Number.parseInt(parts[1] ?? "0", 10),
			createdAt: Number.parseInt(parts[2] ?? "0", 10),
			attached: parts[3] === "1",
		});
	}

	return ok(sessions);
}

export async function listWindows(
	session: string,
): Promise<Result<readonly TmuxWindowInfo[], TmuxError>> {
	const result = await exec([
		"list-windows",
		"-t",
		session,
		"-F",
		"#{window_index}\t#{window_name}\t#{window_active}\t#{pane_id}",
	]);

	if (!result.ok) return result;

	const windows: TmuxWindowInfo[] = [];
	for (const line of result.value.trim().split("\n")) {
		if (!line) continue;
		const parts = line.split("\t");
		windows.push({
			index: Number.parseInt(parts[0] ?? "0", 10),
			name: parts[1] ?? "",
			active: parts[2] === "1",
			paneId: parts[3] ?? "",
		});
	}

	return ok(windows);
}

export async function getPaneVar(
	target: string,
	variable: string,
): Promise<Result<string, TmuxError>> {
	const result = await exec(["display-message", "-t", target, "-p", `#{${variable}}`]);
	if (!result.ok) return result;
	return ok(result.value.trim());
}

export async function setEnv(
	session: string,
	name: string,
	value: string,
): Promise<Result<void, TmuxError>> {
	const result = await exec(["set-environment", "-t", session, name, value]);
	if (!result.ok) return result;
	return ok(undefined);
}
