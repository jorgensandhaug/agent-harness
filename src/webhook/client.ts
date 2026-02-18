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

type DeliverySource = "status_change" | "safety_net" | "manual_test";

export type WebhookDeliveryAttempt = {
	ts: string;
	source: DeliverySource;
	event: WebhookEvent;
	project: string;
	agentId: string;
	provider: string;
	status: string;
	attempt: number;
	ok: boolean;
	httpStatus: number | null;
	error: string | null;
	lastMessagePreview: string | null;
};

export type WebhookClientStatus = {
	enabled: true;
	startedAt: string;
	config: {
		url: string;
		tokenConfigured: boolean;
		events: readonly WebhookEvent[];
		safetyNet: WebhookConfig["safetyNet"];
	};
	counters: {
		attempts: number;
		successes: number;
		failures: number;
		retries: number;
		manualTests: number;
		safetyNetCycles: number;
		safetyNetWarnings: number;
	};
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	lastSafetyNetWarningAt: string | null;
	trackedAgents: {
		lifecycle: number;
		deliveredTerminal: number;
		stuckWarned: number;
	};
	recentAttempts: readonly WebhookDeliveryAttempt[];
};

export type WebhookTestInput = {
	event?: WebhookEvent;
	project?: string;
	agentId?: string;
	provider?: string;
	status?: string;
	lastMessage?: string | null;
};

export type WebhookTestResult = {
	ok: boolean;
	payload: WebhookPayload;
};

export type WebhookClient = (() => void) & {
	getStatus: () => WebhookClientStatus;
	sendTestWebhook: (input?: WebhookTestInput) => Promise<WebhookTestResult>;
};

const MAX_RECENT_ATTEMPTS = 200;

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

function defaultStatusForEvent(event: WebhookEvent): string {
	switch (event) {
		case "agent_completed":
			return "idle";
		case "agent_error":
			return "error";
		case "agent_exited":
			return "exited";
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

function previewText(value: string | null): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return null;
	return normalized.slice(0, 140);
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
): WebhookClient {
	const lifecycleByAgent = new Map<string, LifecycleState>();
	const deliveredTerminalStatusByAgent = new Map<string, AgentStatus>();
	const lastStuckWarnAtMsByAgent = new Map<string, number>();
	let safetyNetTimer: ReturnType<typeof setInterval> | null = null;

	const runtime = {
		startedAt: new Date().toISOString(),
		lastAttemptAt: null as string | null,
		lastSuccessAt: null as string | null,
		lastFailureAt: null as string | null,
		lastSafetyNetWarningAt: null as string | null,
		counters: {
			attempts: 0,
			successes: 0,
			failures: 0,
			retries: 0,
			manualTests: 0,
			safetyNetCycles: 0,
			safetyNetWarnings: 0,
		},
		recentAttempts: [] as WebhookDeliveryAttempt[],
	};

	function pushAttempt(attempt: WebhookDeliveryAttempt): void {
		runtime.recentAttempts.push(attempt);
		if (runtime.recentAttempts.length > MAX_RECENT_ATTEMPTS) {
			runtime.recentAttempts.splice(0, runtime.recentAttempts.length - MAX_RECENT_ATTEMPTS);
		}
	}

	function updateLifecycle(agentId: string, status: AgentStatus, sinceMs: number): void {
		lifecycleByAgent.set(agentId, { status, sinceMs });
		if (!isTerminalStatus(status)) {
			deliveredTerminalStatusByAgent.delete(agentId);
		}
		if (!isStuckCandidateStatus(status)) {
			lastStuckWarnAtMsByAgent.delete(agentId);
		}
	}

	async function postWebhookAttempt(
		payload: WebhookPayload,
		source: DeliverySource,
		attempt: number,
	): Promise<boolean> {
		const ts = new Date().toISOString();
		runtime.counters.attempts += 1;
		runtime.lastAttemptAt = ts;

		const headers: { "Content-Type": string; Authorization?: string } = {
			"Content-Type": "application/json",
		};
		if (webhookConfig.token) {
			headers.Authorization = `Bearer ${webhookConfig.token}`;
		}

		try {
			const response = await fetch(webhookConfig.url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) {
				runtime.counters.failures += 1;
				runtime.lastFailureAt = ts;
				pushAttempt({
					ts,
					source,
					event: payload.event,
					project: payload.project,
					agentId: payload.agentId,
					provider: payload.provider,
					status: payload.status,
					attempt,
					ok: false,
					httpStatus: response.status,
					error: `http_${response.status}`,
					lastMessagePreview: previewText(payload.lastMessage),
				});
				log.warn("webhook POST failed", { url: webhookConfig.url, status: response.status });
				return false;
			}

			runtime.counters.successes += 1;
			runtime.lastSuccessAt = ts;
			pushAttempt({
				ts,
				source,
				event: payload.event,
				project: payload.project,
				agentId: payload.agentId,
				provider: payload.provider,
				status: payload.status,
				attempt,
				ok: true,
				httpStatus: response.status,
				error: null,
				lastMessagePreview: previewText(payload.lastMessage),
			});
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			runtime.counters.failures += 1;
			runtime.lastFailureAt = ts;
			pushAttempt({
				ts,
				source,
				event: payload.event,
				project: payload.project,
				agentId: payload.agentId,
				provider: payload.provider,
				status: payload.status,
				attempt,
				ok: false,
				httpStatus: null,
				error: message,
				lastMessagePreview: previewText(payload.lastMessage),
			});
			log.warn("webhook POST error", {
				url: webhookConfig.url,
				error: message,
			});
			return false;
		}
	}

	async function postWebhookWithRetry(
		payload: WebhookPayload,
		source: DeliverySource,
	): Promise<boolean> {
		const ok = await postWebhookAttempt(payload, source, 1);
		if (ok) return true;
		runtime.counters.retries += 1;
		log.info("webhook retry", { url: webhookConfig.url, event: payload.event, source });
		return postWebhookAttempt(payload, source, 2);
	}

	async function sendTerminalWebhook(
		source: "status_change" | "safety_net",
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

		return postWebhookWithRetry(payload, source);
	}

	const unsubscribe = eventBus.subscribe(
		{ types: ["status_changed"] },
		(event: NormalizedEvent) => {
			if (event.type !== "status_changed") return;
			const sinceMs = parseIsoMs(event.ts) ?? Date.now();
			updateLifecycle(event.agentId, event.to, sinceMs);

			if (event.from !== "processing") return;
			if (!isTerminalStatus(event.to)) return;

			void (async () => {
				const agent = store.getAgent(event.agentId as AgentId);
				const provider = agent?.provider ?? "unknown";
				const sent = await sendTerminalWebhook("status_change", {
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

		runtime.counters.safetyNetCycles += 1;
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
						const sent = await sendTerminalWebhook("safety_net", {
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
					const sent = await sendTerminalWebhook("safety_net", {
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
			runtime.counters.safetyNetWarnings += 1;
			runtime.lastSafetyNetWarningAt = new Date(nowMs).toISOString();
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

	function getStatus(): WebhookClientStatus {
		return {
			enabled: true,
			startedAt: runtime.startedAt,
			config: {
				url: webhookConfig.url,
				tokenConfigured: typeof webhookConfig.token === "string" && webhookConfig.token.length > 0,
				events: [...webhookConfig.events],
				safetyNet: { ...webhookConfig.safetyNet },
			},
			counters: { ...runtime.counters },
			lastAttemptAt: runtime.lastAttemptAt,
			lastSuccessAt: runtime.lastSuccessAt,
			lastFailureAt: runtime.lastFailureAt,
			lastSafetyNetWarningAt: runtime.lastSafetyNetWarningAt,
			trackedAgents: {
				lifecycle: lifecycleByAgent.size,
				deliveredTerminal: deliveredTerminalStatusByAgent.size,
				stuckWarned: lastStuckWarnAtMsByAgent.size,
			},
			recentAttempts: [...runtime.recentAttempts],
		};
	}

	async function sendTestWebhook(input: WebhookTestInput = {}): Promise<WebhookTestResult> {
		runtime.counters.manualTests += 1;
		const event = input.event ?? webhookConfig.events[0] ?? "agent_completed";
		const payload: WebhookPayload = {
			event,
			project: input.project ?? "__inspect_test__",
			agentId: input.agentId ?? "__inspect_test__",
			provider: input.provider ?? "inspect",
			status: input.status ?? defaultStatusForEvent(event),
			lastMessage: input.lastMessage ?? "manual inspector webhook test",
			timestamp: new Date().toISOString(),
		};
		const ok = await postWebhookWithRetry(payload, "manual_test");
		return { ok, payload };
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

	const stop = (() => {
		unsubscribe();
		if (safetyNetTimer) {
			clearInterval(safetyNetTimer);
			safetyNetTimer = null;
		}
	}) as WebhookClient;

	stop.getStatus = getStatus;
	stop.sendTestWebhook = sendTestWebhook;
	return stop;
}
