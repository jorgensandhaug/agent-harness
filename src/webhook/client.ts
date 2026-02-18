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

type LifecycleState = {
	status: AgentStatus;
	sinceMs: number;
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

function isTerminalStatus(status: AgentStatus): boolean {
	return status === "idle" || status === "error" || status === "exited";
}

function isStuckCandidateStatus(status: AgentStatus): boolean {
	return status === "starting" || status === "processing";
}

function parseIsoMs(value: string): number | null {
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
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

async function postWebhookWithRetry(
	webhookConfig: WebhookConfig,
	payload: WebhookPayload,
): Promise<boolean> {
	const ok = await postWebhook(webhookConfig.url, payload, webhookConfig.token);
	if (ok) return true;
	log.info("webhook retry", { url: webhookConfig.url, event: payload.event });
	return postWebhook(webhookConfig.url, payload, webhookConfig.token);
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

async function sendTerminalWebhook(
	webhookConfig: WebhookConfig,
	store: Store,
	input: {
		project: string;
		agentId: string;
		provider: string;
		status: AgentStatus;
		timestamp: string;
	},
): Promise<boolean> {
	const webhookEvent = statusToWebhookEvent(input.status);
	if (!webhookEvent) return false;
	if (!webhookConfig.events.includes(webhookEvent)) return false;

	const lastMessage = await getLastMessage(store, input.agentId as AgentId);
	const payload: WebhookPayload = {
		event: webhookEvent,
		project: input.project,
		agentId: input.agentId,
		provider: input.provider,
		status: input.status,
		lastMessage,
		timestamp: input.timestamp,
	};

	return postWebhookWithRetry(webhookConfig, payload);
}

export function createWebhookClient(
	webhookConfig: WebhookConfig,
	eventBus: EventBus,
	store: Store,
): () => void {
	const lifecycleByAgent = new Map<string, LifecycleState>();
	const deliveredTerminalStatusByAgent = new Map<string, AgentStatus>();
	const lastStuckWarnAtMsByAgent = new Map<string, number>();
	let safetyNetTimer: ReturnType<typeof setInterval> | null = null;

	function updateLifecycle(agentId: string, status: AgentStatus, sinceMs: number): void {
		lifecycleByAgent.set(agentId, { status, sinceMs });
		if (!isTerminalStatus(status)) {
			deliveredTerminalStatusByAgent.delete(agentId);
		}
		if (!isStuckCandidateStatus(status)) {
			lastStuckWarnAtMsByAgent.delete(agentId);
		}
	}

	const unsubscribe = eventBus.subscribe(
		{ types: ["status_changed"] },
		(event: NormalizedEvent) => {
			if (event.type !== "status_changed") return;
			const sinceMs = parseIsoMs(event.ts) ?? Date.now();
			updateLifecycle(event.agentId, event.to, sinceMs);

			if (event.from !== "processing") return;
			if (!isTerminalStatus(event.to)) return;

			// Fire-and-forget: fetch lastMessage then POST (with one retry)
			void (async () => {
				const agent = store.getAgent(event.agentId as AgentId);
				const provider = agent?.provider ?? "unknown";
				const sent = await sendTerminalWebhook(webhookConfig, store, {
					project: event.project,
					agentId: event.agentId,
					provider,
					status: event.to,
					timestamp: event.ts,
				});
				if (sent) {
					deliveredTerminalStatusByAgent.set(event.agentId, event.to);
				}
			})();
		},
	);

	async function runSafetyNetCycle(): Promise<void> {
		const settings = webhookConfig.safetyNet;
		if (!settings.enabled) return;

		const nowMs = Date.now();
		const nowIso = new Date(nowMs).toISOString();
		const agents = store.listAgents();
		const liveAgentIds = new Set<string>();

		for (const agent of agents) {
			liveAgentIds.add(agent.id);
			const previous = lifecycleByAgent.get(agent.id);

			if (!previous || previous.status !== agent.status) {
				updateLifecycle(agent.id, agent.status, nowMs);
				if (isTerminalStatus(agent.status)) {
					if (deliveredTerminalStatusByAgent.get(agent.id) !== agent.status) {
						const timestamp = agent.lastActivity.trim().length > 0 ? agent.lastActivity : nowIso;
						const sent = await sendTerminalWebhook(webhookConfig, store, {
							project: agent.project,
							agentId: agent.id,
							provider: agent.provider,
							status: agent.status,
							timestamp,
						});
						if (sent) {
							deliveredTerminalStatusByAgent.set(agent.id, agent.status);
						}
					}
				}
				continue;
			}

			if (isTerminalStatus(agent.status)) {
				if (deliveredTerminalStatusByAgent.get(agent.id) !== agent.status) {
					const timestamp = agent.lastActivity.trim().length > 0 ? agent.lastActivity : nowIso;
					const sent = await sendTerminalWebhook(webhookConfig, store, {
						project: agent.project,
						agentId: agent.id,
						provider: agent.provider,
						status: agent.status,
						timestamp,
					});
					if (sent) {
						deliveredTerminalStatusByAgent.set(agent.id, agent.status);
					}
				}
				continue;
			}

			if (!isStuckCandidateStatus(agent.status)) continue;
			const ageMs = nowMs - previous.sinceMs;
			if (ageMs < settings.stuckAfterMs) continue;

			const lastWarnMs = lastStuckWarnAtMsByAgent.get(agent.id) ?? 0;
			if (nowMs - lastWarnMs < settings.stuckWarnIntervalMs) continue;

			lastStuckWarnAtMsByAgent.set(agent.id, nowMs);
			log.warn("webhook safety-net detected stuck agent", {
				project: agent.project,
				agentId: agent.id,
				status: agent.status,
				ageMs,
			});
		}

		for (const agentId of lifecycleByAgent.keys()) {
			if (!liveAgentIds.has(agentId)) {
				lifecycleByAgent.delete(agentId);
				deliveredTerminalStatusByAgent.delete(agentId);
				lastStuckWarnAtMsByAgent.delete(agentId);
			}
		}
	}

	if (webhookConfig.safetyNet.enabled) {
		void runSafetyNetCycle();
		safetyNetTimer = setInterval(() => {
			runSafetyNetCycle().catch((error) => {
				log.error("webhook safety-net cycle failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, webhookConfig.safetyNet.intervalMs);
	}

	log.info("webhook client started", {
		url: webhookConfig.url,
		events: webhookConfig.events,
		safetyNetEnabled: webhookConfig.safetyNet.enabled,
		safetyNetIntervalMs: webhookConfig.safetyNet.intervalMs,
	});

	return () => {
		unsubscribe();
		if (safetyNetTimer) {
			clearInterval(safetyNetTimer);
			safetyNetTimer = null;
		}
	};
}
