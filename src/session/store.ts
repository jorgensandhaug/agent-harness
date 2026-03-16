import type { AgentStatus } from "../providers/types.ts";
import type { AgentId, ProjectName } from "../types.ts";
import type { Agent, AgentCallback, Project } from "./types.ts";

export function createStore() {
	const projects = new Map<ProjectName, Project>();
	const agents = new Map<string, Agent>();

	function agentKey(project: ProjectName, id: AgentId): string {
		return `${project}:${id}`;
	}

	function normalizeBriefLines(lines: readonly string[]): string[] {
		return lines
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.slice(-4);
	}

	// --- Projects ---

	function getProject(name: ProjectName): Project | undefined {
		return projects.get(name);
	}

	function listProjects(): readonly Project[] {
		return Array.from(projects.values());
	}

	function addProject(project: Project): void {
		projects.set(project.name, project);
	}

	function removeProject(name: ProjectName): boolean {
		// Remove all agents belonging to this project
		for (const [id, agent] of agents) {
			if (agent.project === name) {
				agents.delete(id);
			}
		}
		return projects.delete(name);
	}

	function updateProjectAgentCount(name: ProjectName): void {
		const project = projects.get(name);
		if (!project) return;
		let count = 0;
		for (const agent of agents.values()) {
			if (agent.project === name) count++;
		}
		project.agentCount = count;
	}

	function updateProject(
		name: ProjectName,
		update: {
			cwd?: string;
			callback?: AgentCallback;
		},
	): void {
		const project = projects.get(name);
		if (!project) return;
		if (update.cwd !== undefined) {
			project.cwd = update.cwd;
		}
		if (update.callback !== undefined) {
			project.callback = update.callback;
		}
	}

	// --- Agents ---

	function getAgent(project: ProjectName, id: AgentId): Agent | undefined {
		return agents.get(agentKey(project, id));
	}

	function listAgents(projectName?: ProjectName): readonly Agent[] {
		const all = Array.from(agents.values());
		if (projectName) {
			return all.filter((a) => a.project === projectName);
		}
		return all;
	}

	function addAgent(agent: Agent): void {
		agents.set(agentKey(agent.project, agent.id), agent);
		updateProjectAgentCount(agent.project);
	}

	function removeAgent(project: ProjectName, id: AgentId): boolean {
		const agent = agents.get(agentKey(project, id));
		if (!agent) return false;
		const projectName = agent.project;
		const deleted = agents.delete(agentKey(project, id));
		if (deleted) updateProjectAgentCount(projectName);
		return deleted;
	}

	function updateAgentStatus(project: ProjectName, id: AgentId, status: AgentStatus): void {
		const agent = agents.get(agentKey(project, id));
		if (agent) {
			agent.status = status;
			agent.lastActivity = new Date().toISOString();
		}
	}

	function updateAgentBrief(project: ProjectName, id: AgentId, brief: string[]): void {
		const agent = agents.get(agentKey(project, id));
		if (agent) {
			agent.brief = normalizeBriefLines(brief);
			agent.lastActivity = new Date().toISOString();
		}
	}

	function updateAgentOutput(project: ProjectName, id: AgentId, output: string): void {
		const agent = agents.get(agentKey(project, id));
		if (agent) {
			agent.lastCapturedOutput = output;
			agent.lastActivity = new Date().toISOString();
		}
	}

	// --- Stats ---

	function stats(): { projects: number; agents: number } {
		return { projects: projects.size, agents: agents.size };
	}

	return {
		getProject,
		listProjects,
		addProject,
		updateProject,
		removeProject,
		getAgent,
		listAgents,
		addAgent,
		removeAgent,
		updateAgentStatus,
		updateAgentBrief,
		updateAgentOutput,
		stats,
	};
}

export type Store = ReturnType<typeof createStore>;
