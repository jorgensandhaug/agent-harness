import type { Argv } from "yargs";
import type { BuildContext, GlobalOptions } from "../main.ts";
import { printJson, printKeyValue, printTable, printText } from "../output.ts";

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
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.createProject({
						name: argv.name,
						cwd: argv.cwd,
					});
					if (context.json) {
						printJson(response);
						return;
					}
					printKeyValue([
						{ key: "created", value: response.project.name },
						{ key: "cwd", value: response.project.cwd },
						{ key: "tmuxSession", value: response.project.tmuxSession },
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
