import { readAgentMessages } from "../session/messages.ts";
import type { Agent } from "../session/types.ts";

export type PublicAgentCallback = {
	url: string;
	discordChannel?: string | undefined;
	sessionKey?: string | undefined;
	extra?: Record<string, string> | undefined;
};

export type PublicAgent = Omit<Agent, "callback"> & {
	callback?: PublicAgentCallback | undefined;
};

function clampBrief(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) return "";
	return trimmed.slice(0, 140);
}

export function fallbackAgentBrief(agent: Agent): string {
	const fromAgent = clampBrief(agent.brief);
	if (fromAgent.length > 0) return fromAgent;
	return agent.status;
}

export async function resolveAgentBrief(agent: Agent): Promise<string> {
	try {
		const result = await readAgentMessages(agent, {
			role: "all",
			limit: 1,
		});
		const lastText = result.lastAssistantMessage?.text;
		if (typeof lastText === "string") {
			const firstLine = clampBrief(lastText.split(/\r?\n/, 1)[0] ?? "");
			if (firstLine.length > 0) return firstLine;
		}
	} catch {
		// best effort only; fall back to cached status brief
	}
	return fallbackAgentBrief(agent);
}

export function redactAgentForApi(agent: Agent): PublicAgent {
	const callback = agent.callback;
	const redactedCallback = callback
		? {
				url: callback.url,
				...(callback.discordChannel ? { discordChannel: callback.discordChannel } : {}),
				...(callback.sessionKey ? { sessionKey: callback.sessionKey } : {}),
				...(callback.extra ? { extra: callback.extra } : {}),
			}
		: undefined;
	return {
		...agent,
		...(redactedCallback ? { callback: redactedCallback } : {}),
	};
}

export function toCompactCreateAgent(agent: Agent): {
	id: string;
	status: Agent["status"];
	tmuxTarget: string;
	attachCommand: string;
} {
	return {
		id: agent.id,
		status: agent.status,
		tmuxTarget: agent.tmuxTarget,
		attachCommand: agent.attachCommand,
	};
}

export function toCompactAgentStatus(
	agent: Agent,
	brief: string,
): {
	id: string;
	status: Agent["status"];
	tmuxTarget: string;
	brief: string;
} {
	return {
		id: agent.id,
		status: agent.status,
		tmuxTarget: agent.tmuxTarget,
		brief: clampBrief(brief) || agent.status,
	};
}

export function toCompactAgentListItem(
	agent: Agent,
	brief: string,
): {
	id: string;
	provider: string;
	status: Agent["status"];
	tmuxTarget: string;
	brief: string;
} {
	return {
		id: agent.id,
		provider: agent.provider,
		status: agent.status,
		tmuxTarget: agent.tmuxTarget,
		brief: clampBrief(brief) || agent.status,
	};
}
