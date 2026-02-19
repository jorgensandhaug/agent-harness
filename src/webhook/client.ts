import type { WebhookConfig, WebhookEvent } from "../config.ts";
import type { EventBus } from "../events/bus.ts";
import type { NormalizedEvent } from "../events/types.ts";
import { log } from "../log.ts";
import type { AgentStatus } from "../providers/types.ts";
import { readAgentMessages } from "../session/messages.ts";
import type { Store } from "../session/store.ts";
import type { Agent, AgentCallback } from "../session/types.ts";
import { type AgentId, projectName } from "../types.ts";

export type WebhookPayload = {
	event: WebhookEvent;
	project: string;
	agentId: string;
	provider: string;
	status: string;
	lastMessage: string | null;
	timestamp: string;
	discordChannel?: string;
	sessionKey?: string;
	extra?: Record<string, string>;
};

type LifecycleState = {
	status: AgentStatus;
	sinceMs: number;
};

type DeliverySource = "status_change" | "safety_net" | "manual_test";
type DeliveryTargetKind = "agent_callback" | "project_callback" | "global_fallback";

type WebhookDeliveryTarget = {
	kind: DeliveryTargetKind;
	url: string;
	token?: string;
	callback?: AgentCallback;
};

export type WebhookDeliveryAttempt = {
	ts: string;
	source: DeliverySource;
	target: DeliveryTargetKind;
	url: string;
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
		globalFallbackConfigured: boolean;
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
	url?: string;
	token?: string;
	discordChannel?: string;
	sessionKey?: string;
	extra?: Record<string, string>;
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
const DEFAULT_SAFETY_NET: WebhookConfig["safetyNet"] = {
	enabled: false,
	intervalMs: 30000,
	stuckAfterMs: 180000,
	stuckWarnIntervalMs: 300000,
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

function isTerminalTransition(from: AgentStatus, to: AgentStatus): boolean {
	if (!isTerminalStatus(to)) return false;
	if (isTerminalStatus(from)) return false;
	return from !== to;
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

function trimToUndefined(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCallback(callback: AgentCallback): AgentCallback | null {
	const url = trimToUndefined(callback.url);
	if (!url) return null;
	const token = trimToUndefined(callback.token);
	const discordChannel = trimToUndefined(callback.discordChannel);
	const sessionKey = trimToUndefined(callback.sessionKey);
	return {
		url,
		...(token ? { token } : {}),
		...(discordChannel ? { discordChannel } : {}),
		...(sessionKey ? { sessionKey } : {}),
		...(callback.extra ? { extra: callback.extra } : {}),
	};
}

function callbackPayloadFields(
	callback: AgentCallback | undefined,
): Pick<WebhookPayload, "discordChannel" | "sessionKey" | "extra"> {
	if (!callback) return {};
	return {
		...(callback.discordChannel ? { discordChannel: callback.discordChannel } : {}),
		...(callback.sessionKey ? { sessionKey: callback.sessionKey } : {}),
		...(callback.extra ? { extra: callback.extra } : {}),
	};
}

async function getLastMessage(
	store: Store,
	project: string,
	agentId: AgentId,
): Promise<string | null> {
	const agent = store.getAgent(projectName(project), agentId);
	if (!agent) return null;

	try {
		const result = await readAgentMessages(agent, { limit: 1, role: "assistant" });
		return result.lastAssistantMessage?.text ?? null;
	} catch {
		return null;
	}
}

function resolveTargetForEvent(
	webhookEvent: WebhookEvent,
	agent: Agent | undefined,
	projectCallback: AgentCallback | undefined,
	globalWebhookConfig: WebhookConfig | null,
): WebhookDeliveryTarget | null {
	if (agent?.callback) {
		const callback = normalizeCallback(agent.callback);
		if (callback) {
			return {
				kind: "agent_callback",
				url: callback.url,
				...(callback.token ? { token: callback.token } : {}),
				callback,
			};
		}
	}
	if (projectCallback) {
		const callback = normalizeCallback(projectCallback);
		if (callback) {
			return {
				kind: "project_callback",
				url: callback.url,
				...(callback.token ? { token: callback.token } : {}),
				callback,
			};
		}
	}
	if (!globalWebhookConfig) return null;
	if (!globalWebhookConfig.events.includes(webhookEvent)) return null;
	return {
		kind: "global_fallback",
		url: globalWebhookConfig.url,
		...(globalWebhookConfig.token ? { token: globalWebhookConfig.token } : {}),
	};
}

function hasValidCallback(agent: Agent): boolean {
	return agent.callback ? normalizeCallback(agent.callback) !== null : false;
}

function hasValidProjectCallback(store: Store, project: string): boolean {
	const projectRecord = store.getProject(projectName(project));
	if (!projectRecord?.callback) return false;
	return normalizeCallback(projectRecord.callback) !== null;
}

function scopedAgentKey(project: string, agentId: string): string {
	return `${project}:${agentId}`;
}

export function createWebhookClient(
	globalWebhookConfig: WebhookConfig | null | undefined,
	eventBus: EventBus,
	store: Store,
): WebhookClient {
	const fallbackWebhookConfig = globalWebhookConfig ?? null;
	const safetyNetConfig = fallbackWebhookConfig?.safetyNet ?? DEFAULT_SAFETY_NET;
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

	function shouldRunSafetyNet(): boolean {
		if (safetyNetConfig.enabled) return true;
		return store
			.listAgents()
			.some((agent) => hasValidCallback(agent) || hasValidProjectCallback(store, agent.project));
	}

	async function postWebhookAttempt(
		payload: WebhookPayload,
		target: WebhookDeliveryTarget,
		source: DeliverySource,
		attempt: number,
	): Promise<boolean> {
		const ts = new Date().toISOString();
		runtime.counters.attempts += 1;
		runtime.lastAttemptAt = ts;

		const headers: { "Content-Type": string; Authorization?: string } = {
			"Content-Type": "application/json",
		};
		if (target.token) {
			headers.Authorization = `Bearer ${target.token}`;
		}

		try {
			const response = await fetch(target.url, {
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
					target: target.kind,
					url: target.url,
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
				log.warn("webhook POST failed", {
					url: target.url,
					status: response.status,
					target: target.kind,
				});
				return false;
			}

			runtime.counters.successes += 1;
			runtime.lastSuccessAt = ts;
			pushAttempt({
				ts,
				source,
				target: target.kind,
				url: target.url,
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
				target: target.kind,
				url: target.url,
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
				url: target.url,
				error: message,
				target: target.kind,
			});
			return false;
		}
	}

	async function postWebhookWithRetry(
		payload: WebhookPayload,
		target: WebhookDeliveryTarget,
		source: DeliverySource,
	): Promise<boolean> {
		const ok = await postWebhookAttempt(payload, target, source, 1);
		if (ok) return true;
		runtime.counters.retries += 1;
		log.info("webhook retry", {
			url: target.url,
			event: payload.event,
			source,
			target: target.kind,
		});
		return postWebhookAttempt(payload, target, source, 2);
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

		const agent = store.getAgent(projectName(input.project), input.agentId as AgentId);
		const projectRecord = store.getProject(projectName(input.project));
		const target = resolveTargetForEvent(
			webhookEvent,
			agent,
			projectRecord?.callback,
			fallbackWebhookConfig,
		);
		if (!target) return false;
		const callbackAgentId = agent?.id ?? input.agentId;

		const lastMessage = await getLastMessage(store, input.project, callbackAgentId as AgentId);
		const payload: WebhookPayload = {
			event: webhookEvent,
			project: input.project,
			agentId: callbackAgentId,
			provider: agent?.provider ?? input.provider,
			status: input.status,
			lastMessage,
			timestamp: input.timestamp,
			...callbackPayloadFields(target.callback),
		};

		return postWebhookWithRetry(payload, target, source);
	}

	const unsubscribe = eventBus.subscribe(
		{ types: ["status_changed"] },
		(event: NormalizedEvent) => {
			if (event.type !== "status_changed") return;
			const sinceMs = parseIsoMs(event.ts) ?? Date.now();
			const scopedId = scopedAgentKey(event.project, event.agentId);
			updateLifecycle(scopedId, event.to, sinceMs);

			if (!isTerminalTransition(event.from, event.to)) return;

			void (async () => {
				const agent = store.getAgent(projectName(event.project), event.agentId as AgentId);
				const provider = agent?.provider ?? "unknown";
				const sent = await sendTerminalWebhook("status_change", {
					project: event.project,
					agentId: event.agentId,
					provider,
					status: event.to,
					timestamp: event.ts,
				});
				if (sent) {
					deliveredTerminalStatusByAgent.set(scopedId, event.to);
				}
			})();
		},
	);

	async function runSafetyNetCycle(): Promise<void> {
		if (!shouldRunSafetyNet()) return;

		runtime.counters.safetyNetCycles += 1;
		const nowMs = Date.now();
		const nowIso = new Date(nowMs).toISOString();
		const agents = store.listAgents();
		const liveAgentIds = new Set<string>();

		for (const agent of agents) {
			const scopedId = scopedAgentKey(agent.project, agent.id);
			liveAgentIds.add(scopedId);
			const previous = lifecycleByAgent.get(scopedId);

			if (!previous || previous.status !== agent.status) {
				updateLifecycle(scopedId, agent.status, nowMs);
				if (isTerminalStatus(agent.status)) {
					if (deliveredTerminalStatusByAgent.get(scopedId) !== agent.status) {
						const timestamp = agent.lastActivity.trim().length > 0 ? agent.lastActivity : nowIso;
						const sent = await sendTerminalWebhook("safety_net", {
							project: agent.project,
							agentId: agent.id,
							provider: agent.provider,
							status: agent.status,
							timestamp,
						});
						if (sent) {
							deliveredTerminalStatusByAgent.set(scopedId, agent.status);
						}
					}
				}
				continue;
			}

			if (isTerminalStatus(agent.status)) {
				if (deliveredTerminalStatusByAgent.get(scopedId) !== agent.status) {
					const timestamp = agent.lastActivity.trim().length > 0 ? agent.lastActivity : nowIso;
					const sent = await sendTerminalWebhook("safety_net", {
						project: agent.project,
						agentId: agent.id,
						provider: agent.provider,
						status: agent.status,
						timestamp,
					});
					if (sent) {
						deliveredTerminalStatusByAgent.set(scopedId, agent.status);
					}
				}
				continue;
			}

			if (!isStuckCandidateStatus(agent.status)) continue;
			const ageMs = nowMs - previous.sinceMs;
			if (ageMs < safetyNetConfig.stuckAfterMs) continue;

			const lastWarnMs = lastStuckWarnAtMsByAgent.get(scopedId) ?? 0;
			if (nowMs - lastWarnMs < safetyNetConfig.stuckWarnIntervalMs) continue;

			lastStuckWarnAtMsByAgent.set(scopedId, nowMs);
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
				url: fallbackWebhookConfig?.url ?? "",
				tokenConfigured:
					typeof fallbackWebhookConfig?.token === "string" &&
					fallbackWebhookConfig.token.length > 0,
				events: fallbackWebhookConfig ? [...fallbackWebhookConfig.events] : [],
				safetyNet: { ...safetyNetConfig },
				globalFallbackConfigured: fallbackWebhookConfig !== null,
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
		const event = input.event ?? fallbackWebhookConfig?.events[0] ?? "agent_completed";
		const callback: AgentCallback | undefined =
			typeof input.url === "string" && input.url.trim().length > 0
				? {
						url: input.url.trim(),
						...(trimToUndefined(input.token) ? { token: trimToUndefined(input.token) } : {}),
						...(trimToUndefined(input.discordChannel)
							? { discordChannel: trimToUndefined(input.discordChannel) }
							: {}),
						...(trimToUndefined(input.sessionKey)
							? { sessionKey: trimToUndefined(input.sessionKey) }
							: {}),
						...(input.extra ? { extra: input.extra } : {}),
					}
				: undefined;
		const target: WebhookDeliveryTarget | null = callback
			? {
					kind: "agent_callback",
					url: callback.url,
					...(callback.token ? { token: callback.token } : {}),
					callback,
				}
			: fallbackWebhookConfig
				? {
						kind: "global_fallback",
						url: fallbackWebhookConfig.url,
						...(fallbackWebhookConfig.token ? { token: fallbackWebhookConfig.token } : {}),
					}
				: null;
		const payload: WebhookPayload = {
			event,
			project: input.project ?? "__inspect_test__",
			agentId: input.agentId ?? "__inspect_test__",
			provider: input.provider ?? "inspect",
			status: input.status ?? defaultStatusForEvent(event),
			lastMessage: input.lastMessage ?? "manual inspector webhook test",
			timestamp: new Date().toISOString(),
			...callbackPayloadFields(callback),
		};

		if (!target) {
			return { ok: false, payload };
		}
		const ok = await postWebhookWithRetry(payload, target, "manual_test");
		return { ok, payload };
	}

	void runSafetyNetCycle();
	safetyNetTimer = setInterval(() => {
		runSafetyNetCycle().catch((error) => {
			log.error("webhook safety-net cycle failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}, safetyNetConfig.intervalMs);

	log.info("webhook client started", {
		globalFallbackConfigured: fallbackWebhookConfig !== null,
		url: fallbackWebhookConfig?.url,
		events: fallbackWebhookConfig?.events ?? [],
		safetyNetEnabled: safetyNetConfig.enabled,
		safetyNetAutoForCallbacks: !safetyNetConfig.enabled,
		safetyNetIntervalMs: safetyNetConfig.intervalMs,
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
