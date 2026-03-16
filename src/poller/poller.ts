import { createHash } from "node:crypto";
import type { HarnessConfig } from "../config.ts";
import type { DebugTracker } from "../debug/tracker.ts";
import type { EventBus } from "../events/bus.ts";
import type { StatusChangeSource } from "../events/types.ts";
import { log } from "../log.ts";
import { getProvider } from "../providers/registry.ts";
import type { AgentStatus } from "../providers/types.ts";
import type { Manager } from "../session/manager.ts";
import { readAgentMessages } from "../session/messages.ts";
import type { Store } from "../session/store.ts";
import type { Agent, AgentTerminalMessageSource, AgentTerminalStatus } from "../session/types.ts";
import * as tmux from "../tmux/client.ts";
import { type AgentId, type ProjectName, newEventId } from "../types.ts";
import { newClaudeInternalsCursor, readClaudeInternalsStatus } from "./claude-internals.ts";
import { newCodexInternalsCursor, readCodexInternalsStatus } from "./codex-internals.ts";
import { diffCaptures } from "./differ.ts";
import { newOpenCodeInternalsCursor, readOpenCodeInternalsStatus } from "./opencode-internals.ts";
import { newPiInternalsCursor, readPiInternalsStatus } from "./pi-internals.ts";
import { shouldUseUiParserForStatus } from "./status-source.ts";
import { deriveStatusFromSignals } from "./status.ts";

type FinalMessageSnapshot = {
	message: string | null;
	source: AgentTerminalMessageSource | null;
};

type PollRuntime = {
	lastDiffAtMs: number | null;
	lastFinalMessage: string | null | undefined;
	lastFinalMessageSource: AgentTerminalMessageSource | null | undefined;
	finalMessageReadCount: number;
	stableFinalMessageReads: number;
	codexCursor: ReturnType<typeof newCodexInternalsCursor>;
	claudeCursor: ReturnType<typeof newClaudeInternalsCursor>;
	piCursor: ReturnType<typeof newPiInternalsCursor>;
	opencodeCursor: ReturnType<typeof newOpenCodeInternalsCursor>;
	lastPaneDeadErrorWarnAtMs: number | null;
	lastPaneCommandErrorWarnAtMs: number | null;
	lastCaptureErrorWarnAtMs: number | null;
};

const IDLE_ERROR_QUIET_MS = 2_000;
const FINALIZATION_HARD_STOP_MS = 10_000;
const EXITED_READ_WINDOW_MS = 1_000;
const EXITED_READ_SETTLE_MS = 250;

function parseIsoMs(value: string | null | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function isTerminalStatus(status: AgentStatus): status is AgentTerminalStatus {
	return status === "idle" || status === "error" || status === "exited";
}

function deliveryIdFor(
	project: string,
	agentId: string,
	status: AgentTerminalStatus,
	observedAt: string,
): string {
	return createHash("sha256")
		.update(`${project}\u0000${agentId}\u0000${status}\u0000${observedAt}`)
		.digest("hex")
		.slice(0, 24);
}

export function createPoller(
	config: HarnessConfig,
	store: Store,
	manager: Manager,
	eventBus: EventBus,
	debugTracker?: DebugTracker,
) {
	const ERROR_LOG_THROTTLE_MS = 30_000;
	let timer: ReturnType<typeof setInterval> | null = null;
	let polling = false;
	const statusRuntime = new Map<string, PollRuntime>();

	function runtimeFor(agentId: string): PollRuntime {
		let found = statusRuntime.get(agentId);
		if (!found) {
			found = {
				lastDiffAtMs: null,
				lastFinalMessage: undefined,
				lastFinalMessageSource: undefined,
				finalMessageReadCount: 0,
				stableFinalMessageReads: 0,
				codexCursor: newCodexInternalsCursor(),
				claudeCursor: newClaudeInternalsCursor(),
				piCursor: newPiInternalsCursor(),
				opencodeCursor: newOpenCodeInternalsCursor(),
				lastPaneDeadErrorWarnAtMs: null,
				lastPaneCommandErrorWarnAtMs: null,
				lastCaptureErrorWarnAtMs: null,
			};
			statusRuntime.set(agentId, found);
		}
		return found;
	}

	function resetFinalizationRuntime(scopedAgentId: string): void {
		const runtime = runtimeFor(scopedAgentId);
		runtime.lastFinalMessage = undefined;
		runtime.lastFinalMessageSource = undefined;
		runtime.finalMessageReadCount = 0;
		runtime.stableFinalMessageReads = 0;
	}

	function shouldWarn(lastWarnAtMs: number | null, nowMs: number): boolean {
		if (lastWarnAtMs === null) return true;
		return nowMs - lastWarnAtMs >= ERROR_LOG_THROTTLE_MS;
	}

	async function readFinalMessageSnapshot(agent: Agent): Promise<FinalMessageSnapshot> {
		try {
			const result = await readAgentMessages(agent, { limit: 1, role: "assistant" });
			return {
				message: result.lastAssistantMessage?.text ?? null,
				source: result.source,
			};
		} catch {
			return {
				message: null,
				source: null,
			};
		}
	}

	function recordFinalMessageSnapshot(
		runtime: PollRuntime,
		snapshot: FinalMessageSnapshot,
	): FinalMessageSnapshot {
		runtime.finalMessageReadCount += 1;
		if (
			runtime.lastFinalMessage === snapshot.message &&
			runtime.lastFinalMessageSource === snapshot.source
		) {
			runtime.stableFinalMessageReads += 1;
		} else {
			runtime.lastFinalMessage = snapshot.message;
			runtime.lastFinalMessageSource = snapshot.source;
			runtime.stableFinalMessageReads = 1;
		}
		return snapshot;
	}

	async function persistTerminalState(agent: Agent): Promise<void> {
		await manager.persistAgentTerminalState(agent.project, agent.id);
	}

	async function clearTerminalLifecycle(agent: Agent, scopedAgentId: string): Promise<void> {
		const hadTerminalState =
			agent.pollState !== "active" ||
			agent.terminalStatus !== null ||
			agent.terminalObservedAt !== null ||
			agent.terminalQuietSince !== null ||
			agent.finalizedAt !== null ||
			agent.deliveryId !== null ||
			agent.deliveryState !== "not_applicable" ||
			agent.deliveryInFlight;
		if (!hadTerminalState) return;

		agent.pollState = "active";
		agent.terminalStatus = null;
		agent.terminalObservedAt = null;
		agent.terminalQuietSince = null;
		agent.finalizedAt = null;
		agent.finalMessage = null;
		agent.finalMessageSource = null;
		agent.deliveryState = "not_applicable";
		agent.deliveryInFlight = false;
		agent.deliveryId = null;
		agent.deliverySentAt = null;
		resetFinalizationRuntime(scopedAgentId);
		await persistTerminalState(agent);
	}

	async function beginFinalizing(
		agent: Agent,
		scopedAgentId: string,
		terminalStatus: AgentTerminalStatus,
		diffHasContent: boolean,
		nowIso: string,
	): Promise<void> {
		const nextQuietSince = terminalStatus === "exited" ? null : diffHasContent ? null : nowIso;
		const needsReset =
			agent.pollState !== "finalizing" ||
			agent.terminalStatus !== terminalStatus ||
			agent.terminalObservedAt === null ||
			agent.finalizedAt !== null ||
			agent.deliveryId === null;

		if (needsReset) {
			agent.pollState = "finalizing";
			agent.terminalStatus = terminalStatus;
			agent.terminalObservedAt = nowIso;
			agent.terminalQuietSince = nextQuietSince;
			agent.finalizedAt = null;
			agent.finalMessage = null;
			agent.finalMessageSource = null;
			agent.deliveryState = "pending";
			agent.deliveryInFlight = false;
			agent.deliveryId = deliveryIdFor(agent.project, agent.id, terminalStatus, nowIso);
			agent.deliverySentAt = null;
			resetFinalizationRuntime(scopedAgentId);
			await persistTerminalState(agent);
			return;
		}

		if (terminalStatus !== "exited") {
			if (diffHasContent && agent.terminalQuietSince !== null) {
				agent.terminalQuietSince = null;
				resetFinalizationRuntime(scopedAgentId);
				await persistTerminalState(agent);
				return;
			}
			if (!diffHasContent && agent.terminalQuietSince === null) {
				agent.terminalQuietSince = nowIso;
				await persistTerminalState(agent);
			}
		}
	}

	async function finalizeTerminal(
		agent: Agent,
		scopedAgentId: string,
		terminalStatus: AgentTerminalStatus,
		snapshot: FinalMessageSnapshot,
		nowIso: string,
	): Promise<void> {
		agent.pollState = "quiesced";
		agent.terminalStatus = terminalStatus;
		if (terminalStatus !== "exited" && agent.terminalQuietSince === null) {
			agent.terminalQuietSince = nowIso;
		}
		agent.finalizedAt = nowIso;
		agent.finalMessage = snapshot.message;
		agent.finalMessageSource = snapshot.source;
		agent.deliveryState = "pending";
		agent.deliveryInFlight = false;
		agent.deliverySentAt = null;
		if (agent.deliveryId === null && agent.terminalObservedAt) {
			agent.deliveryId = deliveryIdFor(
				agent.project,
				agent.id,
				terminalStatus,
				agent.terminalObservedAt,
			);
		}

		await persistTerminalState(agent);
		resetFinalizationRuntime(scopedAgentId);
		statusRuntime.delete(scopedAgentId);
		eventBus.emit({
			id: newEventId(),
			ts: nowIso,
			project: agent.project,
			agentId: agent.id,
			type: "agent_terminal_finalized",
			provider: agent.provider,
			status: terminalStatus,
			finalizedAt: nowIso,
			terminalObservedAt: agent.terminalObservedAt ?? nowIso,
			lastMessage: snapshot.message,
			messageSource: snapshot.source,
			deliveryId: agent.deliveryId,
		});
	}

	async function maybeFinalizeExited(
		agent: Agent,
		scopedAgentId: string,
		runtime: PollRuntime,
		nowMs: number,
		nowIso: string,
	): Promise<void> {
		const observedAtMs = parseIsoMs(agent.terminalObservedAt) ?? nowMs;
		const deadlineMs = observedAtMs + EXITED_READ_WINDOW_MS;
		let snapshot = recordFinalMessageSnapshot(runtime, await readFinalMessageSnapshot(agent));

		while (runtime.finalMessageReadCount < 2 && Date.now() < deadlineMs) {
			const remainingMs = deadlineMs - Date.now();
			if (remainingMs <= 0) break;
			await Bun.sleep(Math.min(EXITED_READ_SETTLE_MS, remainingMs));
			snapshot = recordFinalMessageSnapshot(runtime, await readFinalMessageSnapshot(agent));
		}

		if (runtime.finalMessageReadCount >= 2 || Date.now() >= deadlineMs) {
			await finalizeTerminal(agent, scopedAgentId, "exited", snapshot, nowIso);
		}
	}

	async function maybeFinalizeIdleOrError(
		agent: Agent,
		scopedAgentId: string,
		runtime: PollRuntime,
		diffHasContent: boolean,
		nowMs: number,
		nowIso: string,
	): Promise<void> {
		if (diffHasContent) {
			if (agent.terminalQuietSince !== null) {
				agent.terminalQuietSince = null;
				await persistTerminalState(agent);
			}
			resetFinalizationRuntime(scopedAgentId);
			return;
		}

		if (agent.terminalQuietSince === null) {
			agent.terminalQuietSince = nowIso;
			await persistTerminalState(agent);
		}

		const snapshot = recordFinalMessageSnapshot(runtime, await readFinalMessageSnapshot(agent));
		const quietSinceMs = parseIsoMs(agent.terminalQuietSince) ?? nowMs;
		const observedAtMs = parseIsoMs(agent.terminalObservedAt) ?? nowMs;
		const quietEnough = nowMs - quietSinceMs >= IDLE_ERROR_QUIET_MS;
		const hardStopReached = nowMs - observedAtMs >= FINALIZATION_HARD_STOP_MS;

		if (!quietEnough || runtime.stableFinalMessageReads < 2) return;
		if (snapshot.message !== null || hardStopReached) {
			await finalizeTerminal(
				agent,
				scopedAgentId,
				agent.terminalStatus ?? "idle",
				snapshot,
				nowIso,
			);
		}
	}

	async function reconcileTerminalLifecycle(
		agent: Agent,
		scopedAgentId: string,
		runtime: PollRuntime,
		status: AgentStatus,
		diffHasContent: boolean,
		nowMs: number,
		nowIso: string,
	): Promise<void> {
		if (!isTerminalStatus(status)) {
			await clearTerminalLifecycle(agent, scopedAgentId);
			return;
		}

		await beginFinalizing(agent, scopedAgentId, status, diffHasContent, nowIso);

		if (status === "exited") {
			await maybeFinalizeExited(agent, scopedAgentId, runtime, nowMs, nowIso);
			return;
		}

		await maybeFinalizeIdleOrError(agent, scopedAgentId, runtime, diffHasContent, nowMs, nowIso);
	}

	async function pollAgent(agent: Agent): Promise<void> {
		if ((agent.pollState ?? "active") === "quiesced") return;

		const scopedAgentId = `${agent.project}:${agent.id}`;
		const pollTs = new Date().toISOString();
		debugTracker?.notePoll(scopedAgentId, { lastPollAt: pollTs });

		const providerResult = getProvider(agent.provider);
		if (!providerResult.ok) return;
		const provider = providerResult.value;
		const runtime = runtimeFor(scopedAgentId);
		const nowMs = Date.now();
		const nowIso = new Date(nowMs).toISOString();

		const paneDeadResult = await tmux.getPaneVar(agent.tmuxTarget, "pane_dead");
		if (!paneDeadResult.ok) {
			debugTracker?.noteError(
				scopedAgentId,
				"tmux",
				`pane_dead query failed: ${JSON.stringify(paneDeadResult.error)}`,
			);
			if (shouldWarn(runtime.lastPaneDeadErrorWarnAtMs, nowMs)) {
				runtime.lastPaneDeadErrorWarnAtMs = nowMs;
				log.warn("poller pane_dead query failed", {
					agentId: agent.id,
					tmuxTarget: agent.tmuxTarget,
					error: JSON.stringify(paneDeadResult.error),
				});
			}
		} else {
			debugTracker?.noteTmux(scopedAgentId, { paneDead: paneDeadResult.value === "1" });
			runtime.lastPaneDeadErrorWarnAtMs = null;
		}

		const paneCommandResult = await tmux.getPaneVar(agent.tmuxTarget, "pane_current_command");
		if (!paneCommandResult.ok) {
			debugTracker?.noteError(
				scopedAgentId,
				"tmux",
				`pane_current_command query failed: ${JSON.stringify(paneCommandResult.error)}`,
			);
			if (shouldWarn(runtime.lastPaneCommandErrorWarnAtMs, nowMs)) {
				runtime.lastPaneCommandErrorWarnAtMs = nowMs;
				log.warn("poller pane_current_command query failed", {
					agentId: agent.id,
					tmuxTarget: agent.tmuxTarget,
					error: JSON.stringify(paneCommandResult.error),
				});
			}
		} else {
			debugTracker?.noteTmux(scopedAgentId, { paneCurrentCommand: paneCommandResult.value });
			runtime.lastPaneCommandErrorWarnAtMs = null;
		}

		if (paneDeadResult.ok && paneDeadResult.value === "1") {
			if (agent.status !== "exited") {
				const from = agent.status;
				manager.updateAgentStatus(agent.project as ProjectName, agent.id as AgentId, "exited");
				eventBus.emit({
					id: newEventId(),
					ts: nowIso,
					project: agent.project,
					agentId: agent.id,
					type: "status_changed",
					from,
					to: "exited",
					source: "poller_pane_dead",
				});
				eventBus.emit({
					id: newEventId(),
					ts: nowIso,
					project: agent.project,
					agentId: agent.id,
					type: "agent_exited",
					exitCode: null,
				});
			}
			await reconcileTerminalLifecycle(
				agent,
				scopedAgentId,
				runtime,
				"exited",
				false,
				nowMs,
				nowIso,
			);
			return;
		}

		const captureResult = await tmux.capturePane(agent.tmuxTarget, config.captureLines);
		if (!captureResult.ok) {
			debugTracker?.noteError(
				scopedAgentId,
				"capture",
				`capture-pane failed: ${JSON.stringify(captureResult.error)}`,
			);
			if (shouldWarn(runtime.lastCaptureErrorWarnAtMs, nowMs)) {
				runtime.lastCaptureErrorWarnAtMs = nowMs;
				log.warn("poller capture-pane failed", {
					agentId: agent.id,
					tmuxTarget: agent.tmuxTarget,
					error: JSON.stringify(captureResult.error),
				});
			}
			return;
		}
		runtime.lastCaptureErrorWarnAtMs = null;

		const currentOutput = captureResult.value;
		debugTracker?.notePoll(scopedAgentId, { lastCaptureBytes: currentOutput.length });

		const diff = diffCaptures(agent.lastCapturedOutput, currentOutput);
		debugTracker?.notePoll(scopedAgentId, { lastDiffBytes: diff.length });
		const diffHasContent = diff.trim().length > 0;
		const statusNowMs = Date.now();
		if (diffHasContent) {
			runtime.lastDiffAtMs = statusNowMs;
		}

		manager.updateAgentOutput(agent.project as ProjectName, agent.id as AgentId, currentOutput);

		let providerEvents: ReturnType<typeof provider.parseOutputDiff> = [];
		if (diffHasContent) {
			try {
				providerEvents = provider.parseOutputDiff(diff);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				debugTracker?.noteError(scopedAgentId, "parse", `parseOutputDiff failed: ${msg}`);
			}
		}
		debugTracker?.noteParser(scopedAgentId, {
			lastProviderEventsCount: providerEvents.length,
		});

		const codexStrictStatus = agent.provider === "codex";
		let parsedStatus: AgentStatus = "starting";
		let parsedStatusSource: StatusChangeSource = "fallback_heuristic";
		if (!codexStrictStatus && shouldUseUiParserForStatus(agent)) {
			try {
				parsedStatus = provider.parseStatus(currentOutput);
				parsedStatusSource = "ui_parser";
				debugTracker?.noteParser(scopedAgentId, { lastParsedStatus: parsedStatus });
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				debugTracker?.noteError(scopedAgentId, "parse", `parseStatus failed: ${msg}`);
			}
		}
		if (agent.provider === "codex" && agent.providerRuntimeDir) {
			try {
				const codexInternals = await readCodexInternalsStatus(
					agent.providerRuntimeDir,
					runtime.codexCursor,
				);
				runtime.codexCursor = codexInternals.cursor;
				if (codexInternals.parseErrorCount > 0) {
					debugTracker?.noteError(
						scopedAgentId,
						"parse",
						`codex internals parse errors: ${codexInternals.parseErrorCount}`,
					);
				}
				if (codexInternals.status) {
					parsedStatus = codexInternals.status;
					parsedStatusSource = "internals_codex_jsonl";
					debugTracker?.noteParser(scopedAgentId, { lastParsedStatus: parsedStatus });
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				debugTracker?.noteError(scopedAgentId, "parse", `codex internals read failed: ${msg}`);
			}
		}
		if (agent.provider === "claude-code" && agent.providerSessionFile) {
			try {
				const claudeInternals = await readClaudeInternalsStatus(
					agent.providerSessionFile,
					runtime.claudeCursor,
				);
				runtime.claudeCursor = claudeInternals.cursor;
				if (claudeInternals.parseErrorCount > 0) {
					debugTracker?.noteError(
						scopedAgentId,
						"parse",
						`claude internals parse errors: ${claudeInternals.parseErrorCount}`,
					);
				}
				if (claudeInternals.status) {
					parsedStatus = claudeInternals.status;
					parsedStatusSource = "internals_claude_jsonl";
					debugTracker?.noteParser(scopedAgentId, { lastParsedStatus: parsedStatus });
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				debugTracker?.noteError(scopedAgentId, "parse", `claude internals read failed: ${msg}`);
			}
		}
		if (agent.provider === "pi" && agent.providerRuntimeDir) {
			try {
				const piInternals = await readPiInternalsStatus(agent.providerRuntimeDir, runtime.piCursor);
				runtime.piCursor = piInternals.cursor;
				if (piInternals.parseErrorCount > 0) {
					debugTracker?.noteError(
						scopedAgentId,
						"parse",
						`pi internals parse errors: ${piInternals.parseErrorCount}`,
					);
				}
				if (piInternals.status) {
					parsedStatus = piInternals.status;
					parsedStatusSource = "internals_pi_jsonl";
					debugTracker?.noteParser(scopedAgentId, { lastParsedStatus: parsedStatus });
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				debugTracker?.noteError(scopedAgentId, "parse", `pi internals read failed: ${msg}`);
			}
		}
		if (agent.provider === "opencode" && agent.providerRuntimeDir) {
			try {
				const opencodeInternals = await readOpenCodeInternalsStatus(
					agent.providerRuntimeDir,
					runtime.opencodeCursor,
				);
				runtime.opencodeCursor = opencodeInternals.cursor;
				if (opencodeInternals.parseErrorCount > 0) {
					debugTracker?.noteError(
						scopedAgentId,
						"parse",
						`opencode internals parse errors: ${opencodeInternals.parseErrorCount}`,
					);
				}
				if (opencodeInternals.status) {
					parsedStatus = opencodeInternals.status;
					parsedStatusSource = "internals_opencode_storage";
					debugTracker?.noteParser(scopedAgentId, { lastParsedStatus: parsedStatus });
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				debugTracker?.noteError(scopedAgentId, "parse", `opencode internals read failed: ${msg}`);
			}
		}

		let newStatus: AgentStatus;
		let statusSource: StatusChangeSource;
		if (codexStrictStatus) {
			newStatus = parsedStatus === "starting" ? agent.status : parsedStatus;
			statusSource = "internals_codex_jsonl";
		} else {
			newStatus = deriveStatusFromSignals({
				currentStatus: agent.status,
				parsedStatus,
				paneDead: false,
				paneCurrentCommand: paneCommandResult.ok ? paneCommandResult.value : null,
				currentOutput,
				diff,
				providerEvents,
				lastDiffAtMs: runtime.lastDiffAtMs,
				nowMs: statusNowMs,
			});
			statusSource = newStatus === parsedStatus ? parsedStatusSource : "fallback_heuristic";
		}
		if (newStatus === "processing" && runtime.lastDiffAtMs === null) {
			runtime.lastDiffAtMs = statusNowMs;
		}
		if (newStatus !== agent.status) {
			const from = agent.status;
			manager.updateAgentStatus(agent.project as ProjectName, agent.id as AgentId, newStatus);
			eventBus.emit({
				id: newEventId(),
				ts: nowIso,
				project: agent.project,
				agentId: agent.id,
				type: "status_changed",
				from,
				to: newStatus,
				source: statusSource,
			});
		}

		await reconcileTerminalLifecycle(
			agent,
			scopedAgentId,
			runtime,
			newStatus,
			diffHasContent,
			nowMs,
			nowIso,
		);

		if (diffHasContent) {
			const ts = new Date().toISOString();
			const warnings: string[] = [];

			for (const pe of providerEvents) {
				switch (pe.kind) {
					case "text":
						eventBus.emit({
							id: newEventId(),
							ts,
							project: agent.project,
							agentId: agent.id,
							type: "output",
							text: pe.content,
						});
						break;
					case "tool_start":
						eventBus.emit({
							id: newEventId(),
							ts,
							project: agent.project,
							agentId: agent.id,
							type: "tool_use",
							tool: pe.tool,
							input: pe.input,
						});
						break;
					case "tool_end":
						eventBus.emit({
							id: newEventId(),
							ts,
							project: agent.project,
							agentId: agent.id,
							type: "tool_result",
							tool: pe.tool,
							output: pe.output,
						});
						break;
					case "permission_requested":
						eventBus.emit({
							id: newEventId(),
							ts,
							project: agent.project,
							agentId: agent.id,
							type: "permission_requested",
							description: pe.description,
						});
						break;
					case "question_asked":
						eventBus.emit({
							id: newEventId(),
							ts,
							project: agent.project,
							agentId: agent.id,
							type: "question_asked",
							question: pe.question,
							options: pe.options,
						});
						break;
					case "error":
						eventBus.emit({
							id: newEventId(),
							ts,
							project: agent.project,
							agentId: agent.id,
							type: "error",
							message: pe.message,
						});
						break;
					case "completion":
						eventBus.emit({
							id: newEventId(),
							ts,
							project: agent.project,
							agentId: agent.id,
							type: "output",
							text: pe.summary,
						});
						break;
					case "unknown":
						warnings.push(pe.raw);
						if (agent.provider !== "codex") {
							eventBus.emit({
								id: newEventId(),
								ts,
								project: agent.project,
								agentId: agent.id,
								type: "unknown",
								raw: pe.raw,
							});
						}
						break;
				}
			}

			if (warnings.length > 0) {
				debugTracker?.noteParser(scopedAgentId, { warningsToAppend: warnings });
			}
		} else {
			debugTracker?.noteParser(scopedAgentId, { lastProviderEventsCount: 0 });
		}
	}

	async function poll(): Promise<void> {
		if (polling) return;
		polling = true;

		try {
			const agents = store.listAgents();
			const activeAgents = agents.filter((agent) => (agent.pollState ?? "active") !== "quiesced");

			const promises = activeAgents.map((agent) =>
				pollAgent(agent).catch((error) => {
					log.error("poll error for agent", {
						agentId: agent.id,
						error: error instanceof Error ? error.message : String(error),
					});
				}),
			);

			await Promise.all(promises);
		} finally {
			polling = false;
		}
	}

	function start(): void {
		if (timer) return;
		log.info("poller started", { intervalMs: config.pollIntervalMs });
		timer = setInterval(() => {
			poll().catch((error) => {
				log.error("poll cycle error", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, config.pollIntervalMs);
	}

	function stop(): void {
		if (timer) {
			clearInterval(timer);
			timer = null;
			log.info("poller stopped");
		}
	}

	return { start, stop, poll };
}

export type Poller = ReturnType<typeof createPoller>;
