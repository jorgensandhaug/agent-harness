import { describe, expect, it } from "bun:test";
import yargs from "yargs";
import type { CliHttpClient, CreateProjectRequest, UpdateProjectRequest } from "../http-client.ts";
import type { BuildContext, CommandContext, GlobalOptions } from "../main.ts";
import { registerProjectCommands } from "./projects.ts";

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

describe("cli/commands/projects callback defaults", () => {
	it("sends callback defaults on project create", async () => {
		const createCalls: CreateProjectRequest[] = [];
		const client = {
			async createProject(input: CreateProjectRequest) {
				createCalls.push(input);
				return {
					project: {
						name: input.name,
						cwd: input.cwd,
						tmuxSession: "ah-project-a",
						agentCount: 0,
						createdAt: "2024-01-01T00:00:00.000Z",
						...(input.callback
							? {
									callback: {
										url: input.callback.url,
										...(input.callback.discordChannel
											? { discordChannel: input.callback.discordChannel }
											: {}),
										...(input.callback.sessionKey ? { sessionKey: input.callback.sessionKey } : {}),
									},
								}
							: {}),
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
		registerProjectCommands(parser, buildContext);
		await parser.parseAsync([
			"projects",
			"create",
			"project-a",
			"--cwd",
			"/tmp/project-a",
			"--callback-url",
			"https://hooks.example.test/project-default",
			"--callback-token",
			"project-token",
			"--discord-channel",
			"project-channel",
			"--session-key",
			"project-session",
		]);

		expect(createCalls).toEqual([
			{
				name: "project-a",
				cwd: "/tmp/project-a",
				callback: {
					url: "https://hooks.example.test/project-default",
					token: "project-token",
					discordChannel: "project-channel",
					sessionKey: "project-session",
				},
			},
		]);
	});

	it("sends callback defaults on project update", async () => {
		const updateCalls: Array<{ name: string; input: UpdateProjectRequest }> = [];
		const client = {
			async updateProject(name: string, input: UpdateProjectRequest) {
				updateCalls.push({ name, input });
				return {
					project: {
						name,
						cwd: "/tmp/project-a",
						tmuxSession: "ah-project-a",
						agentCount: 0,
						createdAt: "2024-01-01T00:00:00.000Z",
						callback: {
							url: input.callback.url,
							...(input.callback.discordChannel
								? { discordChannel: input.callback.discordChannel }
								: {}),
							...(input.callback.sessionKey ? { sessionKey: input.callback.sessionKey } : {}),
						},
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
		registerProjectCommands(parser, buildContext);
		await parser.parseAsync([
			"projects",
			"update",
			"project-a",
			"--callback-url",
			"https://hooks.example.test/updated",
			"--callback-token",
			"updated-token",
			"--discord-channel",
			"updated-channel",
			"--session-key",
			"updated-session",
		]);

		expect(updateCalls).toEqual([
			{
				name: "project-a",
				input: {
					callback: {
						url: "https://hooks.example.test/updated",
						token: "updated-token",
						discordChannel: "updated-channel",
						sessionKey: "updated-session",
					},
				},
			},
		]);
	});

	it("requires callback url when callback token/channel/session flags are set", async () => {
		const client = {} as CliHttpClient;
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
		registerProjectCommands(parser, buildContext);

		await expect(
			parser.parseAsync([
				"projects",
				"create",
				"project-a",
				"--cwd",
				"/tmp/project-a",
				"--callback-token",
				"project-token",
			]),
		).rejects.toThrow("--callback-url is required when setting callback token/channel/session fields.");
	});
});
