import type { AgentStatus } from "../providers/types.ts";
import type { EventId } from "../types.ts";

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
			type: "input_sent";
			text: string;
	  };

export type EventFilter = {
	project?: string;
	agentId?: string;
	types?: ReadonlyArray<NormalizedEvent["type"]>;
};
