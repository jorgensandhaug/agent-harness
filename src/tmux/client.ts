import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { log } from "../log.ts";
import { type Result, err, ok } from "../types.ts";
import type { TmuxError, TmuxSessionInfo, TmuxWindowInfo } from "./types.ts";

type ExecRawResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

let bunSpawnDisabled = false;
let lastSeenBunSpawn: typeof Bun.spawn | null = null;

function shouldUseBunSpawn(): boolean {
	if (lastSeenBunSpawn !== Bun.spawn) {
		lastSeenBunSpawn = Bun.spawn;
		bunSpawnDisabled = false;
	}
	return !bunSpawnDisabled;
}

function mergedPath(parts: readonly string[]): string {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of parts) {
		const value = raw.trim();
		if (value.length === 0) continue;
		if (seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out.join(":");
}

function tmuxCommandPath(): string {
	const inherited =
		// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
		process.env["PATH"]?.split(":") ?? [];
	const home =
		// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
		process.env["HOME"] ?? "";
	const userBins = home
		? [`${home}/.local/bin`, `${home}/.bun/bin`, `${home}/.npm-global/bin`, `${home}/.cargo/bin`]
		: [];
	return mergedPath([...userBins, ...inherited, "/run/current-system/sw/bin", "/usr/bin", "/bin"]);
}

function tmuxFallbackBinaries(): string[] {
	const fromEnv =
		// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
		process.env["HARNESS_TMUX_BIN"]?.trim() ?? "";
	const candidates = [fromEnv, "/run/current-system/sw/bin/tmux", "tmux"];
	return Array.from(new Set(candidates.filter((value) => value.length > 0)));
}

async function execWithNodeSpawnBinary(
	binary: string,
	args: readonly string[],
	childEnv: Record<string, string>,
): Promise<ExecRawResult | null> {
	return await new Promise((resolve) => {
		let proc: ReturnType<typeof nodeSpawn>;
		try {
			proc = nodeSpawn(binary, args, {
				env: childEnv,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			resolve(null);
			return;
		}

		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (chunk: string | Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk: string | Buffer) => {
			stderr += chunk.toString();
		});
		proc.on("error", () => resolve(null));
		proc.on("close", (code) =>
			resolve({
				exitCode: code ?? 1,
				stdout,
				stderr,
			}),
		);
	});
}

async function execWithNodeSpawn(
	args: readonly string[],
	childEnv: Record<string, string>,
): Promise<ExecRawResult | null> {
	for (const binary of tmuxFallbackBinaries()) {
		const result = await execWithNodeSpawnBinary(binary, args, childEnv);
		if (result !== null) {
			return result;
		}
	}
	return null;
}

async function execWithBunSpawn(
	args: readonly string[],
	childEnv: Record<string, string>,
): Promise<ExecRawResult | null> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(["tmux", ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: childEnv,
		});
	} catch {
		return null;
	}

	const exitCode = await proc.exited;
	const stdoutStream = proc.stdout;
	const stderrStream = proc.stderr;
	const stdout =
		stdoutStream && typeof stdoutStream !== "number" ? await new Response(stdoutStream).text() : "";
	const stderr =
		stderrStream && typeof stderrStream !== "number" ? await new Response(stderrStream).text() : "";

	return { exitCode, stdout, stderr };
}

async function exec(args: readonly string[]): Promise<Result<string, TmuxError>> {
	log.debug("tmux exec", { args });
	const childEnv: Record<string, string> = {};
	const passThroughKeys = [
		"HOME",
		"TMUX_TMPDIR",
		"LANG",
		"LC_ALL",
		"LOCALE_ARCHIVE",
		"TZDIR",
		"USER",
		"LOGNAME",
		"SHELL",
	] as const;
	for (const key of passThroughKeys) {
		// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
		const value = process.env[key];
		if (typeof value === "string" && value.length > 0) {
			childEnv[key] = value;
		}
	}
	// Preserve user binary locations so tmux-launched panes can run CLI providers.
	childEnv["PATH"] = tmuxCommandPath();
	childEnv["TERM"] =
		// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
		process.env["TERM"] ?? "xterm-256color";

	let runResult: ExecRawResult | null = null;
	if (shouldUseBunSpawn()) {
		runResult = await execWithBunSpawn(args, childEnv);
	}
	if (runResult === null) {
		runResult = await execWithNodeSpawn(args, childEnv);
	}
	if (runResult === null) {
		return err({ code: "TMUX_NOT_INSTALLED" });
	}

	// Bun.spawn can intermittently fail under systemd service env with tmux "server exited unexpectedly".
	// Retry with node child_process in that case.
	if (
		runResult.exitCode !== 0 &&
		runResult.stderr.includes("server exited unexpectedly")
	) {
		const fallback = await execWithNodeSpawn(args, childEnv);
		if (fallback !== null) {
			if (!bunSpawnDisabled) {
				bunSpawnDisabled = true;
			}
			log.warn("tmux bun spawn failed; switching to node spawn", {
				args,
				stderr: runResult.stderr.trim(),
			});
			runResult = fallback;
		}
	}

	const { exitCode, stdout, stderr } = runResult;

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
		"#{session_name}\t#{session_path}\t#{session_windows}\t#{session_created}\t#{session_attached}",
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
			path: parts[1] ?? ".",
			windowCount: Number.parseInt(parts[2] ?? "0", 10),
			createdAt: Number.parseInt(parts[3] ?? "0", 10),
			attached: parts[4] === "1",
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
