export interface TmuxSessionInfo {
	name: string;
	windowCount: number;
	createdAt: number;
	attached: boolean;
}

export interface TmuxWindowInfo {
	index: number;
	name: string;
	active: boolean;
	paneId: string;
}

export type TmuxError =
	| { code: "SESSION_NOT_FOUND"; session: string }
	| { code: "WINDOW_NOT_FOUND"; target: string }
	| { code: "TMUX_NOT_INSTALLED" }
	| { code: "COMMAND_FAILED"; command: string; stderr: string; exitCode: number };

import type { Result } from "../types.ts";

export interface TmuxClient {
	createSession(name: string, cwd: string): Promise<Result<void, TmuxError>>;
	createWindow(
		session: string,
		name: string,
		cwd: string,
		cmd?: readonly string[],
		env?: Record<string, string>,
	): Promise<Result<string, TmuxError>>;
	sendInput(target: string, text: string): Promise<Result<void, TmuxError>>;
	sendKeys(target: string, keys: string): Promise<Result<void, TmuxError>>;
	capturePane(target: string, lines: number): Promise<Result<string, TmuxError>>;
	startPipePane(target: string, logPath: string): Promise<Result<void, TmuxError>>;
	stopPipePane(target: string): Promise<Result<void, TmuxError>>;
	killWindow(target: string): Promise<Result<void, TmuxError>>;
	killSession(name: string): Promise<Result<void, TmuxError>>;
	hasSession(name: string): Promise<boolean>;
	listSessions(prefix: string): Promise<Result<readonly TmuxSessionInfo[], TmuxError>>;
	listWindows(session: string): Promise<Result<readonly TmuxWindowInfo[], TmuxError>>;
	getPaneVar(target: string, variable: string): Promise<Result<string, TmuxError>>;
	setEnv(session: string, name: string, value: string): Promise<Result<void, TmuxError>>;
}
