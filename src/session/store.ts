import type { AgentStatus } from "../providers/types.ts";
import type { AgentId, ProjectName } from "../types.ts";
import type { Agent, Project } from "./types.ts";

export function createStore() {
	const projects = new Map<ProjectName, Project>();
	const agents = new Map<AgentId, Agent>();

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

	// --- Agents ---

	function getAgent(id: AgentId): Agent | undefined {
		return agents.get(id);
	}

	function listAgents(projectName?: ProjectName): readonly Agent[] {
		const all = Array.from(agents.values());
		if (projectName) {
			return all.filter((a) => a.project === projectName);
		}
		return all;
	}

	function addAgent(agent: Agent): void {
		agents.set(agent.id, agent);
		updateProjectAgentCount(agent.project);
	}

	function removeAgent(id: AgentId): boolean {
		const agent = agents.get(id);
		if (!agent) return false;
		const projectName = agent.project;
		const deleted = agents.delete(id);
		if (deleted) updateProjectAgentCount(projectName);
		return deleted;
	}

	function updateAgentStatus(id: AgentId, status: AgentStatus): void {
		const agent = agents.get(id);
		if (agent) {
			agent.status = status;
			agent.lastActivity = new Date().toISOString();
		}
	}

	function updateAgentOutput(id: AgentId, output: string): void {
		const agent = agents.get(id);
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
		removeProject,
		getAgent,
		listAgents,
		addAgent,
		removeAgent,
		updateAgentStatus,
		updateAgentOutput,
		stats,
	};
}

export type Store = ReturnType<typeof createStore>;
