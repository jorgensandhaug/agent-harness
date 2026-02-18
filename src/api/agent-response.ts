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

function toBriefLine(text: string): string {
	return clampBrief(text.split(/\r?\n/, 1)[0] ?? "");
}

function normalizeBriefLines(lines: readonly string[]): string[] {
	return lines
		.map(toBriefLine)
		.filter((line) => line.length > 0)
		.slice(-4);
}

export function fallbackAgentBrief(agent: Agent): string[] {
	const normalized = normalizeBriefLines(agent.brief);
	if (agent.status === "processing") return normalized.slice(-4);
	const last = normalized[normalized.length - 1];
	return last ? [last] : [];
}

export async function resolveAgentBrief(agent: Agent): Promise<string[]> {
	const isProcessing = agent.status === "processing";
	const limit = isProcessing ? 4 : 1;
	try {
		const result = await readAgentMessages(agent, {
			role: "assistant",
			limit,
		});

		const fromMessages = normalizeBriefLines(result.messages.map((message) => message.text));
		if (isProcessing) {
			if (fromMessages.length > 0) return fromMessages.slice(-4);
		} else {
			const last = fromMessages[fromMessages.length - 1];
			if (last) return [last];
		}
	} catch {
		// best effort only; fall back to cached message-derived brief
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
	brief: string[],
): {
	id: string;
	status: Agent["status"];
	tmuxTarget: string;
	brief: string[];
} {
	const normalized = normalizeBriefLines(brief);
	return {
		id: agent.id,
		status: agent.status,
		tmuxTarget: agent.tmuxTarget,
		brief: normalized,
	};
}

export function toCompactAgentListItem(
	agent: Agent,
	brief: string[],
): {
	id: string;
	provider: string;
	status: Agent["status"];
	tmuxTarget: string;
	brief: string[];
} {
	const normalized = normalizeBriefLines(brief);
	return {
		id: agent.id,
		provider: agent.provider,
		status: agent.status,
		tmuxTarget: agent.tmuxTarget,
		brief: normalized,
	};
}
