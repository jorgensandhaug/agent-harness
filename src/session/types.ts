import type { AgentStatus } from "../providers/types.ts";
import type { AgentId, ProjectName } from "../types.ts";

export interface Project {
	name: ProjectName;
	cwd: string;
	tmuxSession: string;
	agentCount: number;
	callback?: AgentCallback;
	createdAt: string; // ISO 8601
}

export interface AgentCallback {
	url: string;
	token?: string | undefined;
	discordChannel?: string | undefined;
	sessionKey?: string | undefined;
	extra?: Record<string, string> | undefined;
}

export interface Agent {
	id: AgentId;
	project: ProjectName;
	provider: string;
	status: AgentStatus;
	brief: string[];
	task: string;
	windowName: string;
	tmuxTarget: string;
	attachCommand: string;
	subscriptionId?: string;
	callback?: AgentCallback;
	providerRuntimeDir?: string;
	providerSessionFile?: string;
	createdAt: string;
	lastActivity: string;
	lastCapturedOutput: string;
}
