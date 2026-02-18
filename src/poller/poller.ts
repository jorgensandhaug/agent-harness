import type { HarnessConfig } from "../config.ts";
import type { DebugTracker } from "../debug/tracker.ts";
import type { EventBus } from "../events/bus.ts";
import type { StatusChangeSource } from "../events/types.ts";
import { log } from "../log.ts";
import { getProvider } from "../providers/registry.ts";
import type { AgentStatus } from "../providers/types.ts";
import type { Manager } from "../session/manager.ts";
import type { Store } from "../session/store.ts";
import * as tmux from "../tmux/client.ts";
import { type AgentId, newEventId } from "../types.ts";
import { newClaudeInternalsCursor, readClaudeInternalsStatus } from "./claude-internals.ts";
import { newCodexInternalsCursor, readCodexInternalsStatus } from "./codex-internals.ts";
import { diffCaptures } from "./differ.ts";
import { newOpenCodeInternalsCursor, readOpenCodeInternalsStatus } from "./opencode-internals.ts";
import { newPiInternalsCursor, readPiInternalsStatus } from "./pi-internals.ts";
import { shouldUseUiParserForStatus } from "./status-source.ts";
import { deriveStatusFromSignals } from "./status.ts";

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
	const statusRuntime = new Map<
		string,
		{
			lastDiffAtMs: number | null;
			codexCursor: ReturnType<typeof newCodexInternalsCursor>;
			claudeCursor: ReturnType<typeof newClaudeInternalsCursor>;
			piCursor: ReturnType<typeof newPiInternalsCursor>;
			opencodeCursor: ReturnType<typeof newOpenCodeInternalsCursor>;
			lastPaneDeadErrorWarnAtMs: number | null;
			lastPaneCommandErrorWarnAtMs: number | null;
			lastCaptureErrorWarnAtMs: number | null;
		}
	>();

	function runtimeFor(agentId: string): {
		lastDiffAtMs: number | null;
		codexCursor: ReturnType<typeof newCodexInternalsCursor>;
		claudeCursor: ReturnType<typeof newClaudeInternalsCursor>;
		piCursor: ReturnType<typeof newPiInternalsCursor>;
		opencodeCursor: ReturnType<typeof newOpenCodeInternalsCursor>;
		lastPaneDeadErrorWarnAtMs: number | null;
		lastPaneCommandErrorWarnAtMs: number | null;
		lastCaptureErrorWarnAtMs: number | null;
	} {
		let found = statusRuntime.get(agentId);
		if (!found) {
			found = {
				lastDiffAtMs: null,
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

	function shouldWarn(lastWarnAtMs: number | null, nowMs: number): boolean {
		if (lastWarnAtMs === null) return true;
		return nowMs - lastWarnAtMs >= ERROR_LOG_THROTTLE_MS;
	}

	async function pollAgent(agent: {
		id: string;
		provider: string;
		tmuxTarget: string;
		project: string;
		status: AgentStatus;
		lastCapturedOutput: string;
		providerRuntimeDir?: string;
		providerSessionFile?: string;
	}): Promise<void> {
		const pollTs = new Date().toISOString();
		debugTracker?.notePoll(agent.id, { lastPollAt: pollTs });

		const providerResult = getProvider(agent.provider);
		if (!providerResult.ok) return;
		const provider = providerResult.value;
		const runtime = runtimeFor(agent.id);
		const nowMs = Date.now();

		// Check if pane is dead (process exited)
		const paneDeadResult = await tmux.getPaneVar(agent.tmuxTarget, "pane_dead");
		if (!paneDeadResult.ok) {
			debugTracker?.noteError(
				agent.id,
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
			debugTracker?.noteTmux(agent.id, { paneDead: paneDeadResult.value === "1" });
			runtime.lastPaneDeadErrorWarnAtMs = null;
		}

		const paneCommandResult = await tmux.getPaneVar(agent.tmuxTarget, "pane_current_command");
		if (!paneCommandResult.ok) {
			debugTracker?.noteError(
				agent.id,
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
			debugTracker?.noteTmux(agent.id, { paneCurrentCommand: paneCommandResult.value });
			runtime.lastPaneCommandErrorWarnAtMs = null;
		}

		if (paneDeadResult.ok && paneDeadResult.value === "1") {
			statusRuntime.delete(agent.id);
			if (agent.status !== "exited") {
				const from = agent.status;
				manager.updateAgentStatus(agent.id as AgentId, "exited");
				eventBus.emit({
					id: newEventId(),
					ts: new Date().toISOString(),
					project: agent.project,
					agentId: agent.id,
					type: "status_changed",
					from,
					to: "exited",
					source: "poller_pane_dead",
				});
				eventBus.emit({
					id: newEventId(),
					ts: new Date().toISOString(),
					project: agent.project,
					agentId: agent.id,
					type: "agent_exited",
					exitCode: null,
				});
			}
			return;
		}

		// Capture pane content
		const captureResult = await tmux.capturePane(agent.tmuxTarget, config.captureLines);
		if (!captureResult.ok) {
			debugTracker?.noteError(
				agent.id,
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
		debugTracker?.notePoll(agent.id, { lastCaptureBytes: currentOutput.length });

		// Detect new content via diff
		const diff = diffCaptures(agent.lastCapturedOutput, currentOutput);
		debugTracker?.notePoll(agent.id, { lastDiffBytes: diff.length });
		const diffHasContent = diff.trim().length > 0;
		const statusNowMs = Date.now();
		if (diffHasContent) {
			runtime.lastDiffAtMs = statusNowMs;
		}

		// Update stored output
		manager.updateAgentOutput(agent.id as AgentId, currentOutput);

		let providerEvents: ReturnType<typeof provider.parseOutputDiff> = [];
		if (diffHasContent) {
			try {
				providerEvents = provider.parseOutputDiff(diff);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				debugTracker?.noteError(agent.id, "parse", `parseOutputDiff failed: ${msg}`);
			}
		}
		debugTracker?.noteParser(agent.id, {
			lastProviderEventsCount: providerEvents.length,
		});

		let parsedStatus: AgentStatus = "starting";
		let parsedStatusSource: StatusChangeSource = "fallback_heuristic";
		if (shouldUseUiParserForStatus(agent)) {
			try {
				parsedStatus = provider.parseStatus(currentOutput);
				parsedStatusSource = "ui_parser";
				debugTracker?.noteParser(agent.id, { lastParsedStatus: parsedStatus });
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				debugTracker?.noteError(agent.id, "parse", `parseStatus failed: ${msg}`);
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
						agent.id,
						"parse",
						`codex internals parse errors: ${codexInternals.parseErrorCount}`,
					);
				}
				if (codexInternals.status) {
					parsedStatus = codexInternals.status;
					parsedStatusSource = "internals_codex_jsonl";
					debugTracker?.noteParser(agent.id, { lastParsedStatus: parsedStatus });
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				debugTracker?.noteError(agent.id, "parse", `codex internals read failed: ${msg}`);
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
						agent.id,
						"parse",
						`claude internals parse errors: ${claudeInternals.parseErrorCount}`,
					);
				}
				if (claudeInternals.status) {
					parsedStatus = claudeInternals.status;
					parsedStatusSource = "internals_claude_jsonl";
					debugTracker?.noteParser(agent.id, { lastParsedStatus: parsedStatus });
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				debugTracker?.noteError(agent.id, "parse", `claude internals read failed: ${msg}`);
			}
		}
		if (agent.provider === "pi" && agent.providerRuntimeDir) {
			try {
				const piInternals = await readPiInternalsStatus(agent.providerRuntimeDir, runtime.piCursor);
				runtime.piCursor = piInternals.cursor;
				if (piInternals.parseErrorCount > 0) {
					debugTracker?.noteError(
						agent.id,
						"parse",
						`pi internals parse errors: ${piInternals.parseErrorCount}`,
					);
				}
				if (piInternals.status) {
					parsedStatus = piInternals.status;
					parsedStatusSource = "internals_pi_jsonl";
					debugTracker?.noteParser(agent.id, { lastParsedStatus: parsedStatus });
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				debugTracker?.noteError(agent.id, "parse", `pi internals read failed: ${msg}`);
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
						agent.id,
						"parse",
						`opencode internals parse errors: ${opencodeInternals.parseErrorCount}`,
					);
				}
				if (opencodeInternals.status) {
					parsedStatus = opencodeInternals.status;
					parsedStatusSource = "internals_opencode_storage";
					debugTracker?.noteParser(agent.id, { lastParsedStatus: parsedStatus });
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				debugTracker?.noteError(agent.id, "parse", `opencode internals read failed: ${msg}`);
			}
		}
		const newStatus = deriveStatusFromSignals({
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
		if (newStatus === "processing" && runtime.lastDiffAtMs === null) {
			runtime.lastDiffAtMs = statusNowMs;
		}
		const statusSource: StatusChangeSource =
			newStatus === parsedStatus ? parsedStatusSource : "fallback_heuristic";
		if (newStatus !== agent.status) {
			const from = agent.status;
			manager.updateAgentStatus(agent.id as AgentId, newStatus);
			eventBus.emit({
				id: newEventId(),
				ts: new Date().toISOString(),
				project: agent.project,
				agentId: agent.id,
				type: "status_changed",
				from,
				to: newStatus,
				source: statusSource,
			});
		}

		// Parse new output into events
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
						eventBus.emit({
							id: newEventId(),
							ts,
							project: agent.project,
							agentId: agent.id,
							type: "unknown",
							raw: pe.raw,
						});
						break;
				}
			}

			if (warnings.length > 0) {
				debugTracker?.noteParser(agent.id, { warningsToAppend: warnings });
			}
		} else {
			debugTracker?.noteParser(agent.id, { lastProviderEventsCount: 0 });
		}
	}

	async function poll(): Promise<void> {
		if (polling) return; // Skip if previous poll still running
		polling = true;

		try {
			const agents = store.listAgents();
			const activeAgents = agents.filter((a) => a.status !== "exited");

			const promises = activeAgents.map((agent) =>
				pollAgent({
					id: agent.id,
					provider: agent.provider,
					tmuxTarget: agent.tmuxTarget,
					project: agent.project,
					status: agent.status,
					lastCapturedOutput: agent.lastCapturedOutput,
					...(agent.providerRuntimeDir ? { providerRuntimeDir: agent.providerRuntimeDir } : {}),
					...(agent.providerSessionFile ? { providerSessionFile: agent.providerSessionFile } : {}),
				}).catch((e) => {
					log.error("poll error for agent", {
						agentId: agent.id,
						error: e instanceof Error ? e.message : String(e),
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
			poll().catch((e) => {
				log.error("poll cycle error", {
					error: e instanceof Error ? e.message : String(e),
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
