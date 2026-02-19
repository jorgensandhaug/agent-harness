import type { Argv } from "yargs";
import type { BuildContext, GlobalOptions } from "../main.ts";
import { printJson, printKeyValue, printTable, printText } from "../output.ts";

type ProjectCallbackArgv = {
	callbackUrl?: string;
	callbackToken?: string;
	discordChannel?: string;
	sessionKey?: string;
};

function resolveProjectCallback(argv: ProjectCallbackArgv) {
	const hasNonUrlField =
		argv.callbackToken !== undefined ||
		argv.discordChannel !== undefined ||
		argv.sessionKey !== undefined;
	if (!argv.callbackUrl) {
		if (hasNonUrlField) {
			throw new Error("--callback-url is required when setting callback token/channel/session fields.");
		}
		return undefined;
	}

	return {
		url: argv.callbackUrl,
		...(argv.callbackToken ? { token: argv.callbackToken } : {}),
		...(argv.discordChannel ? { discordChannel: argv.discordChannel } : {}),
		...(argv.sessionKey ? { sessionKey: argv.sessionKey } : {}),
	};
}

export function registerProjectCommands(
	yargs: Argv<GlobalOptions>,
	buildContext: BuildContext,
): void {
	yargs.command("projects", "Project management commands", (projects) =>
		projects
			.command(
				"list",
				"List projects",
				(builder) => builder,
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.listProjects();
					if (context.json) {
						printJson(response);
						return;
					}
					if (response.projects.length === 0) {
						printText("No projects found.");
						return;
					}
					printTable(
						["NAME", "CWD", "AGENTS", "CREATED", "TMUX SESSION"],
						response.projects.map((project) => [
							project.name,
							project.cwd,
							project.agentCount,
							project.createdAt,
							project.tmuxSession,
						]),
					);
				},
			)
			.command(
				"create <name>",
				"Create a project",
				(builder) =>
					builder
						.positional("name", {
							type: "string",
							demandOption: true,
							describe: "Project name",
						})
						.option("cwd", {
							type: "string",
							demandOption: true,
							describe: "Project working directory",
						})
						.option("callback-url", {
							type: "string",
							describe: "Default webhook callback URL for agents in this project",
						})
						.option("callback-token", {
							type: "string",
							describe: "Default callback bearer token for agents in this project",
						})
						.option("discord-channel", {
							type: "string",
							describe: "Default callback discord channel for agents in this project",
						})
						.option("session-key", {
							type: "string",
							describe: "Default callback session key for agents in this project",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const callback = resolveProjectCallback(argv);
					const response = await context.client.createProject({
						name: argv.name,
						cwd: argv.cwd,
						...(callback ? { callback } : {}),
					});
					if (context.json) {
						printJson(response);
						return;
					}
					printKeyValue([
						{ key: "created", value: response.project.name },
						{ key: "cwd", value: response.project.cwd },
						{ key: "tmuxSession", value: response.project.tmuxSession },
						{
							key: "callbackUrl",
							value: response.project.callback?.url ?? "(none)",
						},
						{
							key: "discordChannel",
							value: response.project.callback?.discordChannel ?? "(none)",
						},
						{
							key: "sessionKey",
							value: response.project.callback?.sessionKey ?? "(none)",
						},
					]);
				},
			)
			.command(
				"update <name>",
				"Update project defaults",
				(builder) =>
					builder
						.positional("name", {
							type: "string",
							demandOption: true,
							describe: "Project name",
						})
						.option("callback-url", {
							type: "string",
							demandOption: true,
							describe: "Default webhook callback URL for agents in this project",
						})
						.option("callback-token", {
							type: "string",
							describe: "Default callback bearer token for agents in this project",
						})
						.option("discord-channel", {
							type: "string",
							describe: "Default callback discord channel for agents in this project",
						})
						.option("session-key", {
							type: "string",
							describe: "Default callback session key for agents in this project",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const callback = resolveProjectCallback(argv);
					if (!callback) {
						throw new Error("callback defaults are required for project update.");
					}
					const response = await context.client.updateProject(argv.name, { callback });
					if (context.json) {
						printJson(response);
						return;
					}
					printKeyValue([
						{ key: "updated", value: response.project.name },
						{ key: "callbackUrl", value: response.project.callback?.url ?? "(none)" },
						{
							key: "discordChannel",
							value: response.project.callback?.discordChannel ?? "(none)",
						},
						{ key: "sessionKey", value: response.project.callback?.sessionKey ?? "(none)" },
					]);
				},
			)
			.command(
				"get <name>",
				"Get a project",
				(builder) =>
					builder.positional("name", {
						type: "string",
						demandOption: true,
						describe: "Project name",
					}),
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.getProject(argv.name);
					if (context.json) {
						printJson(response);
						return;
					}

					printKeyValue([
						{ key: "name", value: response.project.name },
						{ key: "cwd", value: response.project.cwd },
						{ key: "tmuxSession", value: response.project.tmuxSession },
						{ key: "agents", value: response.project.agentCount },
						{ key: "callbackUrl", value: response.project.callback?.url ?? "(none)" },
						{
							key: "discordChannel",
							value: response.project.callback?.discordChannel ?? "(none)",
						},
						{ key: "sessionKey", value: response.project.callback?.sessionKey ?? "(none)" },
						{ key: "created", value: response.project.createdAt },
					]);

					if (response.agents.length === 0) {
						printText("\nNo agents in project.");
						return;
					}
					printText("\nAgents:");
					printTable(
						["ID", "PROVIDER", "STATUS", "TMUX TARGET"],
						response.agents.map((agent) => [
							agent.id,
							agent.provider,
							agent.status,
							agent.tmuxTarget,
						]),
					);
				},
			)
			.command(
				"delete <name>",
				"Delete a project",
				(builder) =>
					builder.positional("name", {
						type: "string",
						demandOption: true,
						describe: "Project name",
					}),
				async (argv) => {
					const context = await buildContext(argv);
					await context.client.deleteProject(argv.name);
					if (context.json) {
						printJson({ deleted: true, project: argv.name });
						return;
					}
					printText(`Deleted project '${argv.name}'.`);
				},
			)
			.demandCommand(1)
			.strict(),
	);
}
