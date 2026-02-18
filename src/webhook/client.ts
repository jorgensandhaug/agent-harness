import type { WebhookConfig, WebhookEvent } from "../config.ts";
import type { EventBus } from "../events/bus.ts";
import type { NormalizedEvent } from "../events/types.ts";
import { log } from "../log.ts";
import type { AgentStatus } from "../providers/types.ts";
import { readAgentMessages } from "../session/messages.ts";
import type { Store } from "../session/store.ts";
import type { AgentId } from "../types.ts";

export type WebhookPayload = {
	event: WebhookEvent;
	project: string;
	agentId: string;
	provider: string;
	status: string;
	lastMessage: string | null;
	timestamp: string;
};

function statusToWebhookEvent(to: AgentStatus): WebhookEvent | null {
	switch (to) {
		case "idle":
			return "agent_completed";
		case "error":
			return "agent_error";
		case "exited":
			return "agent_exited";
		default:
			return null;
	}
}

async function postWebhook(
	url: string,
	payload: WebhookPayload,
	token: string | undefined,
): Promise<boolean> {
	const headers: { "Content-Type": string; Authorization?: string } = {
		"Content-Type": "application/json",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			log.warn("webhook POST failed", { url, status: response.status });
			return false;
		}
		return true;
	} catch (error) {
		log.warn("webhook POST error", {
			url,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

async function getLastMessage(store: Store, agentId: AgentId): Promise<string | null> {
	const agent = store.getAgent(agentId);
	if (!agent) return null;

	try {
		const result = await readAgentMessages(agent, { limit: 1, role: "assistant" });
		return result.lastAssistantMessage?.text ?? null;
	} catch {
		return null;
	}
}

export function createWebhookClient(
	webhookConfig: WebhookConfig,
	eventBus: EventBus,
	store: Store,
): () => void {
	const unsubscribe = eventBus.subscribe(
		{ types: ["status_changed"] },
		(event: NormalizedEvent) => {
			if (event.type !== "status_changed") return;
			if (event.from !== "processing") return;

			const webhookEvent = statusToWebhookEvent(event.to);
			if (!webhookEvent) return;
			if (!webhookConfig.events.includes(webhookEvent)) return;

			// Look up the agent to get provider name
			const agent = store.getAgent(event.agentId as AgentId);
			const provider = agent?.provider ?? "unknown";

			// Fire-and-forget: fetch lastMessage then POST (with one retry)
			void (async () => {
				const lastMessage = await getLastMessage(store, event.agentId as AgentId);
				const payload: WebhookPayload = {
					event: webhookEvent,
					project: event.project,
					agentId: event.agentId,
					provider,
					status: event.to,
					lastMessage,
					timestamp: event.ts,
				};

				const ok = await postWebhook(webhookConfig.url, payload, webhookConfig.token);
				if (!ok) {
					log.info("webhook retry", { url: webhookConfig.url, event: webhookEvent });
					await postWebhook(webhookConfig.url, payload, webhookConfig.token);
				}
			})();
		},
	);

	log.info("webhook client started", {
		url: webhookConfig.url,
		events: webhookConfig.events,
	});

	return unsubscribe;
}
