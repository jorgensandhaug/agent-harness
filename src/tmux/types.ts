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
