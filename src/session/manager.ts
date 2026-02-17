import type { HarnessConfig } from "../config.ts";
import type { EventBus } from "../events/bus.ts";
import { log } from "../log.ts";
import { getProvider } from "../providers/registry.ts";
import type { AgentStatus } from "../providers/types.ts";
import * as tmux from "../tmux/client.ts";
import {
	type AgentId,
	type ProjectName,
	type Result,
	agentId,
	err,
	newAgentId,
	newEventId,
	ok,
	projectName,
} from "../types.ts";
import type { Store } from "./store.ts";
import type { Agent, Project } from "./types.ts";

type ManagerError =
	| { code: "PROJECT_NOT_FOUND"; name: string }
	| { code: "PROJECT_EXISTS"; name: string }
	| { code: "AGENT_NOT_FOUND"; id: string; project: string }
	| { code: "UNKNOWN_PROVIDER"; name: string }
	| { code: "PROVIDER_DISABLED"; name: string }
	| { code: "TMUX_ERROR"; message: string };

export function createManager(config: HarnessConfig, store: Store, eventBus: EventBus) {
	function tmuxSessionName(name: ProjectName): string {
		return `${config.tmuxPrefix}-${name}`;
	}

	function windowName(providerName: string): string {
		const hex = Math.random().toString(16).slice(2, 6);
		return `${providerName}-${hex}`;
	}

	// --- Projects ---

	async function createProject(
		name: string,
		cwd: string,
	): Promise<Result<Project, ManagerError>> {
		const pName = projectName(name);

		if (store.getProject(pName)) {
			return err({ code: "PROJECT_EXISTS", name });
		}

		const sessionName = tmuxSessionName(pName);
		const sessionResult = await tmux.createSession(sessionName, cwd);
		if (!sessionResult.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to create tmux session: ${JSON.stringify(sessionResult.error)}`,
			});
		}

		const project: Project = {
			name: pName,
			cwd,
			tmuxSession: sessionName,
			agentCount: 0,
			createdAt: new Date().toISOString(),
		};

		store.addProject(project);
		log.info("project created", { name, session: sessionName });
		return ok(project);
	}

	function getProject(name: string): Result<Project, ManagerError> {
		const project = store.getProject(projectName(name));
		if (!project) {
			return err({ code: "PROJECT_NOT_FOUND", name });
		}
		return ok(project);
	}

	function listProjects(): readonly Project[] {
		return store.listProjects();
	}

	async function deleteProject(name: string): Promise<Result<void, ManagerError>> {
		const pName = projectName(name);
		const project = store.getProject(pName);
		if (!project) {
			return err({ code: "PROJECT_NOT_FOUND", name });
		}

		// Kill tmux session
		await tmux.killSession(project.tmuxSession);

		store.removeProject(pName);
		log.info("project deleted", { name });
		return ok(undefined);
	}

	// --- Agents ---

	async function createAgent(
		projectNameStr: string,
		providerName: string,
		task: string,
		model?: string,
	): Promise<Result<Agent, ManagerError>> {
		const pName = projectName(projectNameStr);
		const project = store.getProject(pName);
		if (!project) {
			return err({ code: "PROJECT_NOT_FOUND", name: projectNameStr });
		}

		const providerResult = getProvider(providerName);
		if (!providerResult.ok) {
			return err({ code: "UNKNOWN_PROVIDER", name: providerName });
		}
		const provider = providerResult.value;

		// Get provider config from harness config
		const providerConfig = config.providers[providerName];
		if (!providerConfig) {
			return err({ code: "UNKNOWN_PROVIDER", name: providerName });
		}
		if (!providerConfig.enabled) {
			return err({ code: "PROVIDER_DISABLED", name: providerName });
		}

		// Override model if specified
		const effectiveConfig = model
			? { ...providerConfig, model }
			: providerConfig;

		const id = newAgentId();
		const wName = windowName(providerName);
		const cmd = provider.buildCommand(effectiveConfig);
		const env = provider.buildEnv(effectiveConfig);
		const target = `${project.tmuxSession}:${wName}`;

		// Create tmux window with the agent command
		const windowResult = await tmux.createWindow(
			project.tmuxSession,
			wName,
			project.cwd,
			cmd,
			env,
		);
		if (!windowResult.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to create window: ${JSON.stringify(windowResult.error)}`,
			});
		}

		const now = new Date().toISOString();
		const agent: Agent = {
			id,
			project: pName,
			provider: providerName,
			status: "starting",
			task,
			windowName: wName,
			tmuxTarget: target,
			createdAt: now,
			lastActivity: now,
			lastCapturedOutput: "",
		};

		store.addAgent(agent);

		// Emit agent_started event
		eventBus.emit({
			id: newEventId(),
			ts: now,
			project: projectNameStr,
			agentId: id,
			type: "agent_started",
			provider: providerName,
		});

		log.info("agent created", { id, provider: providerName, project: projectNameStr });

		// Send the initial task after a brief delay to let the agent start
		setTimeout(async () => {
			const formattedInput = provider.formatInput(task);
			const inputResult = await tmux.sendInput(target, formattedInput);
			if (!inputResult.ok) {
				log.error("failed to send initial task", {
					agentId: id,
					error: JSON.stringify(inputResult.error),
				});
			} else {
				eventBus.emit({
					id: newEventId(),
					ts: new Date().toISOString(),
					project: projectNameStr,
					agentId: id,
					type: "input_sent",
					text: task,
				});
			}
		}, 2000);

		return ok(agent);
	}

	function getAgent(
		projectNameStr: string,
		id: string,
	): Result<Agent, ManagerError> {
		const agent = store.getAgent(agentId(id));
		if (!agent || agent.project !== projectName(projectNameStr)) {
			return err({ code: "AGENT_NOT_FOUND", id, project: projectNameStr });
		}
		return ok(agent);
	}

	function listAgents(projectNameStr: string): Result<readonly Agent[], ManagerError> {
		const pName = projectName(projectNameStr);
		if (!store.getProject(pName)) {
			return err({ code: "PROJECT_NOT_FOUND", name: projectNameStr });
		}
		return ok(store.listAgents(pName));
	}

	async function sendInput(
		projectNameStr: string,
		id: string,
		text: string,
	): Promise<Result<void, ManagerError>> {
		const agentResult = getAgent(projectNameStr, id);
		if (!agentResult.ok) return agentResult;
		const agent = agentResult.value;

		const providerResult = getProvider(agent.provider);
		if (!providerResult.ok) {
			return err({ code: "UNKNOWN_PROVIDER", name: agent.provider });
		}

		const formatted = providerResult.value.formatInput(text);
		const result = await tmux.sendInput(agent.tmuxTarget, formatted);
		if (!result.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to send input: ${JSON.stringify(result.error)}`,
			});
		}

		eventBus.emit({
			id: newEventId(),
			ts: new Date().toISOString(),
			project: projectNameStr,
			agentId: agent.id,
			type: "input_sent",
			text,
		});

		return ok(undefined);
	}

	async function getAgentOutput(
		projectNameStr: string,
		id: string,
		lines?: number,
	): Promise<Result<{ output: string; lines: number }, ManagerError>> {
		const agentResult = getAgent(projectNameStr, id);
		if (!agentResult.ok) return agentResult;
		const agent = agentResult.value;

		const captureLines = lines ?? config.captureLines;
		const result = await tmux.capturePane(agent.tmuxTarget, captureLines);
		if (!result.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to capture pane: ${JSON.stringify(result.error)}`,
			});
		}

		const outputLines = result.value.split("\n");
		return ok({ output: result.value, lines: outputLines.length });
	}

	async function abortAgent(
		projectNameStr: string,
		id: string,
	): Promise<Result<void, ManagerError>> {
		const agentResult = getAgent(projectNameStr, id);
		if (!agentResult.ok) return agentResult;
		const agent = agentResult.value;

		// Send Escape then Ctrl-C
		await tmux.sendKeys(agent.tmuxTarget, "Escape");
		const result = await tmux.sendKeys(agent.tmuxTarget, "C-c");
		if (!result.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to send abort: ${JSON.stringify(result.error)}`,
			});
		}

		return ok(undefined);
	}

	async function deleteAgent(
		projectNameStr: string,
		id: string,
	): Promise<Result<void, ManagerError>> {
		const agentResult = getAgent(projectNameStr, id);
		if (!agentResult.ok) return agentResult;
		const agent = agentResult.value;

		const providerResult = getProvider(agent.provider);
		if (providerResult.ok) {
			// Try to gracefully exit
			const exitCmd = providerResult.value.exitCommand();
			await tmux.sendInput(agent.tmuxTarget, `${exitCmd}\n`);
			// Wait a moment for graceful exit
			await Bun.sleep(1000);
		}

		// Kill the window regardless
		await tmux.killWindow(agent.tmuxTarget);

		// Emit exit event
		eventBus.emit({
			id: newEventId(),
			ts: new Date().toISOString(),
			project: projectNameStr,
			agentId: agent.id,
			type: "agent_exited",
			exitCode: null,
		});

		store.removeAgent(agent.id);
		log.info("agent deleted", { id, project: projectNameStr });
		return ok(undefined);
	}

	function updateAgentStatus(id: AgentId, status: AgentStatus): void {
		store.updateAgentStatus(id, status);
	}

	function updateAgentOutput(id: AgentId, output: string): void {
		store.updateAgentOutput(id, output);
	}

	return {
		createProject,
		getProject,
		listProjects,
		deleteProject,
		createAgent,
		getAgent,
		listAgents,
		sendInput,
		getAgentOutput,
		abortAgent,
		deleteAgent,
		updateAgentStatus,
		updateAgentOutput,
	};
}

export type Manager = ReturnType<typeof createManager>;
