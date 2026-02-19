import type { Argv } from "yargs";
import { serveCommand } from "../../serve.ts";
import type { BuildContext, GlobalOptions } from "../main.ts";
import { printJson, printKeyValue, printText } from "../output.ts";

function registerHealthCommand(yargs: Argv<GlobalOptions>, buildContext: BuildContext): void {
	yargs.command(
		"health",
		"Check daemon health endpoint",
		(builder) => builder,
		async (argv) => {
			const context = await buildContext(argv);
			const health = await context.client.health();
			if (context.json) {
				printJson(health);
				return;
			}
			printKeyValue([
				{ key: "status", value: "running" },
				{ key: "url", value: `${context.config.url}/api/v1/health` },
				{ key: "uptime", value: `${health.uptime}s` },
				{ key: "projects", value: health.projects },
				{ key: "agents", value: health.agents },
				{ key: "tmux", value: health.tmuxAvailable ? "available" : "unavailable" },
				{ key: "version", value: health.version },
			]);
		},
	);
}

export function registerDaemonCommands(
	yargs: Argv<GlobalOptions>,
	buildContext: BuildContext,
): void {
	yargs.command("daemon", "Daemon lifecycle commands", (daemon) =>
		daemon
			.command(
				"serve",
				"Start daemon",
				(builder) => builder,
				async () => {
					await serveCommand();
				},
			)
			.command(
				"status",
				"Check daemon status",
				(builder) => builder,
				async (argv) => {
					const context = await buildContext(argv);
					const health = await context.client.health();
					if (context.json) {
						printJson({ status: "running", url: context.config.url, health });
						if (!health.tmuxAvailable) process.exitCode = 1;
						return;
					}

					printKeyValue([
						{ key: "status", value: health.tmuxAvailable ? "running" : "degraded" },
						{ key: "url", value: context.config.url },
						{ key: "uptime", value: `${health.uptime}s` },
						{ key: "projects", value: health.projects },
						{ key: "agents", value: health.agents },
						{ key: "tmux", value: health.tmuxAvailable ? "available" : "unavailable" },
						{ key: "version", value: health.version },
					]);
					if (!health.tmuxAvailable) process.exitCode = 1;
				},
			)
			.command(
				"inspect",
				"Fetch inspector HTML page",
				(builder) => builder,
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.rawRequest({
						method: "GET",
						path: "/inspect",
					});
					if (context.json) {
						printJson(response);
						if (response.status >= 400) process.exitCode = 1;
						return;
					}
					if (typeof response.text === "string") {
						printKeyValue([
							{ key: "status", value: response.status },
							{ key: "contentType", value: response.contentType ?? "" },
						]);
						printText("");
						printText(response.text);
					} else {
						printKeyValue([
							{ key: "status", value: response.status },
							{ key: "contentType", value: response.contentType ?? "" },
						]);
					}
					if (response.status >= 400) process.exitCode = 1;
				},
			)
			.demandCommand(1)
			.strict(),
	);

	registerHealthCommand(yargs, buildContext);
}
