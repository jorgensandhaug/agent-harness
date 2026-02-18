import type { AgentStatus } from "../providers/types.ts";
import type { AgentId, ProjectName } from "../types.ts";

export interface Project {
	name: ProjectName;
	cwd: string;
	tmuxSession: string;
	agentCount: number;
	createdAt: string; // ISO 8601
}

export interface Agent {
	id: AgentId;
	project: ProjectName;
	provider: string;
	status: AgentStatus;
	task: string;
	windowName: string;
	tmuxTarget: string;
	attachCommand: string;
	subscriptionId?: string;
	providerRuntimeDir?: string;
	providerSessionFile?: string;
	createdAt: string;
	lastActivity: string;
	lastCapturedOutput: string;
}
