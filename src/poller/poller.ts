import type { HarnessConfig } from "../config.ts";
import type { EventBus } from "../events/bus.ts";
import { log } from "../log.ts";
import { getProvider } from "../providers/registry.ts";
import type { AgentStatus } from "../providers/types.ts";
import type { Manager } from "../session/manager.ts";
import type { Store } from "../session/store.ts";
import * as tmux from "../tmux/client.ts";
import { type AgentId, newEventId } from "../types.ts";
import { diffCaptures } from "./differ.ts";

export function createPoller(
	config: HarnessConfig,
	store: Store,
	manager: Manager,
	eventBus: EventBus,
) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let polling = false;

	async function pollAgent(agent: {
		id: string;
		provider: string;
		tmuxTarget: string;
		project: string;
		status: AgentStatus;
		lastCapturedOutput: string;
	}): Promise<void> {
		const providerResult = getProvider(agent.provider);
		if (!providerResult.ok) return;
		const provider = providerResult.value;

		// Check if pane is dead (process exited)
		const paneDeadResult = await tmux.getPaneVar(agent.tmuxTarget, "pane_dead");
		if (paneDeadResult.ok && paneDeadResult.value === "1") {
			if (agent.status !== "exited") {
				const from = agent.status;
				manager.updateAgentStatus(
					agent.id as AgentId,
					"exited",
				);
				eventBus.emit({
					id: newEventId(),
					ts: new Date().toISOString(),
					project: agent.project,
					agentId: agent.id,
					type: "status_changed",
					from,
					to: "exited",
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
			log.debug("failed to capture pane", {
				agentId: agent.id,
				error: JSON.stringify(captureResult.error),
			});
			return;
		}

		const currentOutput = captureResult.value;

		// Detect new content via diff
		const diff = diffCaptures(agent.lastCapturedOutput, currentOutput);

		// Update stored output
		manager.updateAgentOutput(
			agent.id as AgentId,
			currentOutput,
		);

		// Parse current status
		const newStatus = provider.parseStatus(currentOutput);
		if (newStatus !== agent.status) {
			const from = agent.status;
			manager.updateAgentStatus(
				agent.id as AgentId,
				newStatus,
			);
			eventBus.emit({
				id: newEventId(),
				ts: new Date().toISOString(),
				project: agent.project,
				agentId: agent.id,
				type: "status_changed",
				from,
				to: newStatus,
			});
		}

		// Parse new output into events
		if (diff && diff.trim().length > 0) {
			const providerEvents = provider.parseOutputDiff(diff);
			const ts = new Date().toISOString();

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
				}
			}
		}
	}

	async function poll(): Promise<void> {
		if (polling) return; // Skip if previous poll still running
		polling = true;

		try {
			const agents = store.listAgents();
			const activeAgents = agents.filter(
				(a) => a.status !== "exited",
			);

			const promises = activeAgents.map((agent) =>
				pollAgent({
					id: agent.id,
					provider: agent.provider,
					tmuxTarget: agent.tmuxTarget,
					project: agent.project,
					status: agent.status,
					lastCapturedOutput: agent.lastCapturedOutput,
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
