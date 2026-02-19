import { describe, expect, it } from "bun:test";
import yargs from "yargs";
import type { CliHttpClient, CreateAgentRequest } from "../http-client.ts";
import type { BuildContext, CommandContext, GlobalOptions } from "../main.ts";
import { registerAgentCommands } from "./agents.ts";

function createParser() {
	return yargs()
		.exitProcess(false)
		.fail((message, error) => {
			if (error) throw error;
			throw new Error(message ?? "Invalid command");
		})
		.strict()
		.recommendCommands()
		.scriptName("ah")
		.wrap(null);
}

describe("cli/commands/agents.create callback defaults", () => {
	it("prefers project callback defaults over resolved CLI config defaults", async () => {
		const createCalls: Array<{ project: string; input: CreateAgentRequest }> = [];
		const getProjectCalls: string[] = [];
		const client = {
			async getProject(name: string) {
				getProjectCalls.push(name);
				return {
					project: {
						name,
						cwd: "/tmp/project-a",
						tmuxSession: "ah-project-a",
						agentCount: 0,
						createdAt: "2024-01-01T00:00:00.000Z",
						callback: {
							url: "https://hooks.example.test/project-default",
							discordChannel: "project-channel",
							sessionKey: "project-session",
						},
					},
					agents: [],
				};
			},
			async createAgent(project: string, input: CreateAgentRequest) {
				createCalls.push({ project, input });
				return {
					agent: {
						id: "a1",
						status: "starting",
						tmuxTarget: "ah:test.1",
						attachCommand: "tmux attach -t ah:test",
					},
				};
			},
		} as unknown as CliHttpClient;

		const buildContext: BuildContext = async (_argv: GlobalOptions): Promise<CommandContext> => ({
			config: {
				url: "http://127.0.0.1:7070",
				json: true,
				compact: false,
				configPath: "/tmp/cli.json",
				callbackUrl: "https://hooks.example.test/default",
				callbackToken: "default-token",
				discordChannel: "default-channel",
				sessionKey: "default-session",
			},
			client,
			json: true,
			compact: false,
		});

		const parser = createParser();
		registerAgentCommands(parser, buildContext);
		await parser.parseAsync([
			"agents",
			"create",
			"project-a",
			"--provider",
			"codex",
			"--task",
			"test task",
		]);

		expect(createCalls).toHaveLength(1);
		expect(getProjectCalls).toEqual(["project-a"]);
		expect(createCalls[0]).toEqual({
			project: "project-a",
			input: {
				provider: "codex",
				task: "test task",
			},
		});
	});

	it("falls back to resolved CLI config defaults when project callback is not set", async () => {
		const createCalls: Array<{ project: string; input: CreateAgentRequest }> = [];
		const getProjectCalls: string[] = [];
		const client = {
			async getProject(name: string) {
				getProjectCalls.push(name);
				return {
					project: {
						name,
						cwd: "/tmp/project-a",
						tmuxSession: "ah-project-a",
						agentCount: 0,
						createdAt: "2024-01-01T00:00:00.000Z",
					},
					agents: [],
				};
			},
			async createAgent(project: string, input: CreateAgentRequest) {
				createCalls.push({ project, input });
				return {
					agent: {
						id: "a1",
						status: "starting",
						tmuxTarget: "ah:test.1",
						attachCommand: "tmux attach -t ah:test",
					},
				};
			},
		} as unknown as CliHttpClient;

		const buildContext: BuildContext = async (_argv: GlobalOptions): Promise<CommandContext> => ({
			config: {
				url: "http://127.0.0.1:7070",
				json: true,
				compact: false,
				configPath: "/tmp/cli.json",
				callbackUrl: "https://hooks.example.test/default",
				callbackToken: "default-token",
				discordChannel: "default-channel",
				sessionKey: "default-session",
			},
			client,
			json: true,
			compact: false,
		});

		const parser = createParser();
		registerAgentCommands(parser, buildContext);
		await parser.parseAsync([
			"agents",
			"create",
			"project-a",
			"--provider",
			"codex",
			"--task",
			"test task",
		]);

		expect(createCalls).toHaveLength(1);
		expect(getProjectCalls).toEqual(["project-a"]);
		expect(createCalls[0]).toEqual({
			project: "project-a",
			input: {
				provider: "codex",
				task: "test task",
				callback: {
					url: "https://hooks.example.test/default",
					token: "default-token",
					discordChannel: "default-channel",
					sessionKey: "default-session",
				},
			},
		});
	});

	it("prefers callback flags over project and CLI config defaults", async () => {
		const createCalls: Array<{ project: string; input: CreateAgentRequest }> = [];
		const getProjectCalls: string[] = [];
		const client = {
			async getProject(name: string) {
				getProjectCalls.push(name);
				return {
					project: {
						name,
						cwd: "/tmp/project-a",
						tmuxSession: "ah-project-a",
						agentCount: 0,
						createdAt: "2024-01-01T00:00:00.000Z",
						callback: {
							url: "https://hooks.example.test/project-default",
							discordChannel: "project-channel",
							sessionKey: "project-session",
						},
					},
					agents: [],
				};
			},
			async createAgent(project: string, input: CreateAgentRequest) {
				createCalls.push({ project, input });
				return {
					agent: {
						id: "a1",
						status: "starting",
						tmuxTarget: "ah:test.1",
						attachCommand: "tmux attach -t ah:test",
					},
				};
			},
		} as unknown as CliHttpClient;

		const buildContext: BuildContext = async (_argv: GlobalOptions): Promise<CommandContext> => ({
			config: {
				url: "http://127.0.0.1:7070",
				json: true,
				compact: false,
				configPath: "/tmp/cli.json",
				callbackUrl: "https://hooks.example.test/default",
				callbackToken: "default-token",
				discordChannel: "default-channel",
				sessionKey: "default-session",
			},
			client,
			json: true,
			compact: false,
		});

		const parser = createParser();
		registerAgentCommands(parser, buildContext);
		await parser.parseAsync([
			"agents",
			"create",
			"project-a",
			"--provider",
			"codex",
			"--task",
			"test task",
			"--callback-url",
			"https://hooks.example.test/from-flag",
			"--callback-token",
			"flag-token",
			"--discord-channel",
			"flag-channel",
			"--session-key",
			"flag-session",
		]);

		expect(createCalls).toHaveLength(1);
		expect(getProjectCalls).toEqual(["project-a"]);
		expect(createCalls[0]).toEqual({
			project: "project-a",
			input: {
				provider: "codex",
				task: "test task",
				callback: {
					url: "https://hooks.example.test/from-flag",
					token: "flag-token",
					discordChannel: "flag-channel",
					sessionKey: "flag-session",
				},
			},
		});
	});

	it("forwards optional --name to create agent request", async () => {
		const createCalls: Array<{ project: string; input: CreateAgentRequest }> = [];
		const getProjectCalls: string[] = [];
		const client = {
			async getProject(name: string) {
				getProjectCalls.push(name);
				return {
					project: {
						name,
						cwd: "/tmp/project-a",
						tmuxSession: "ah-project-a",
						agentCount: 0,
						createdAt: "2024-01-01T00:00:00.000Z",
					},
					agents: [],
				};
			},
			async createAgent(project: string, input: CreateAgentRequest) {
				createCalls.push({ project, input });
				return {
					agent: {
						id: "human-readable-name",
						status: "starting",
						tmuxTarget: "ah:test.1",
						attachCommand: "tmux attach -t ah:test",
					},
				};
			},
		} as unknown as CliHttpClient;

		const buildContext: BuildContext = async (_argv: GlobalOptions): Promise<CommandContext> => ({
			config: {
				url: "http://127.0.0.1:7070",
				json: true,
				compact: false,
				configPath: "/tmp/cli.json",
			},
			client,
			json: true,
			compact: false,
		});

		const parser = createParser();
		registerAgentCommands(parser, buildContext);
		await parser.parseAsync([
			"agents",
			"create",
			"project-a",
			"--provider",
			"codex",
			"--task",
			"test task",
			"--name",
			"human-readable-name",
		]);

		expect(createCalls).toHaveLength(1);
		expect(getProjectCalls).toEqual(["project-a"]);
		expect(createCalls[0]).toEqual({
			project: "project-a",
			input: {
				provider: "codex",
				task: "test task",
				name: "human-readable-name",
			},
		});
	});
});

describe("cli/commands/agents.debug", () => {
	it("calls debug endpoint for agent", async () => {
		const debugCalls: Array<{ project: string; agentId: string }> = [];
		const client = {
			async getAgentDebug(project: string, agentId: string) {
				debugCalls.push({ project, agentId });
				return { debug: { tmux: { paneDead: false } } };
			},
		} as unknown as CliHttpClient;

		const buildContext: BuildContext = async (_argv: GlobalOptions): Promise<CommandContext> => ({
			config: {
				url: "http://127.0.0.1:7070",
				json: true,
				compact: false,
				configPath: "/tmp/cli.json",
			},
			client,
			json: true,
			compact: false,
		});

		const parser = createParser();
		registerAgentCommands(parser, buildContext);
		await parser.parseAsync(["agents", "debug", "project-a", "agent-1"]);

		expect(debugCalls).toEqual([{ project: "project-a", agentId: "agent-1" }]);
	});
});
