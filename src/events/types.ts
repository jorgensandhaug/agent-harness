import type { AgentStatus } from "../providers/types.ts";
import type { AgentTerminalMessageSource, AgentTerminalStatus } from "../session/types.ts";
import type { EventId } from "../types.ts";

export type StatusChangeSource =
	| "manager_initial_input"
	| "manager_followup_input"
	| "manager_send_input_preflight"
	| "poller_pane_dead"
	| "poller_session_not_found"
	| "ui_parser"
	| "internals_codex_jsonl"
	| "internals_claude_jsonl"
	| "internals_pi_jsonl"
	| "internals_opencode_storage"
	| "fallback_heuristic";

export type NormalizedEvent =
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "agent_started";
			provider: string;
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "status_changed";
			from: AgentStatus;
			to: AgentStatus;
			source?: StatusChangeSource;
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "output";
			text: string;
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "tool_use";
			tool: string;
			input: string;
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "tool_result";
			tool: string;
			output: string;
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "error";
			message: string;
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "agent_exited";
			exitCode: number | null;
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "agent_terminal_finalized";
			provider: string;
			status: AgentTerminalStatus;
			finalizedAt: string;
			terminalObservedAt: string;
			lastMessage: string | null;
			messageSource: AgentTerminalMessageSource | null;
			deliveryId: string | null;
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "agent_terminal_finalized";
			provider: string;
			status: Extract<AgentStatus, "idle" | "error" | "exited">;
			finalizedAt: string;
			terminalObservedAt: string;
			lastMessage: string | null;
			messageSource: string | null;
			deliveryId: string;
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "agent_terminal_finalized";
			provider: string;
			status: Extract<AgentStatus, "idle" | "error" | "exited">;
			finalizedAt: string;
			terminalObservedAt: string;
			lastMessage: string | null;
			messageSource: StatusChangeSource | "internals_unavailable" | null;
			deliveryId: string | null;
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "input_sent";
			text: string;
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "permission_requested";
			description: string;
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "question_asked";
			question: string;
			options: readonly string[];
	  }
	| {
			id: EventId;
			ts: string;
			project: string;
			agentId: string;
			type: "unknown";
			raw: string;
	  };

export type EventFilter = {
	project?: string;
	agentId?: string;
	types?: ReadonlyArray<NormalizedEvent["type"]>;
};
