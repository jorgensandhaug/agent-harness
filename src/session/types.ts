import type { StatusChangeSource } from "../events/types.ts";
import type { AgentStatus } from "../providers/types.ts";
import type { AgentId, ProjectName } from "../types.ts";

export type AgentPollState = "active" | "finalizing" | "quiesced";
export type AgentTerminalStatus = Extract<AgentStatus, "idle" | "error" | "exited">;
export type AgentTerminalMessageSource = StatusChangeSource | "internals_unavailable";
export type AgentTerminalDeliveryState = "pending" | "sent" | "not_applicable";

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

export interface AgentTerminalState {
	pollState: AgentPollState;
	terminalStatus: AgentTerminalStatus | null;
	terminalObservedAt: string | null;
	terminalQuietSince: string | null;
	finalizedAt: string | null;
	finalMessage: string | null;
	finalMessageSource: AgentTerminalMessageSource | null;
	deliveryState: AgentTerminalDeliveryState;
	deliveryInFlight: boolean;
	deliveryId: string | null;
	deliverySentAt: string | null;
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
	pollState: AgentPollState;
	terminalStatus: AgentTerminalStatus | null;
	terminalObservedAt: string | null;
	terminalQuietSince: string | null;
	finalizedAt: string | null;
	finalMessage: string | null;
	finalMessageSource: AgentTerminalMessageSource | null;
	deliveryState: AgentTerminalDeliveryState;
	deliveryInFlight: boolean;
	deliveryId: string | null;
	deliverySentAt: string | null;
}
