import yargs, { type Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import { getHarnessVersion } from "../version.ts";
import { registerAgentCommands } from "./commands/agents.ts";
import { registerApiCommands } from "./commands/api.ts";
import { registerDaemonCommands } from "./commands/daemon.ts";
import { registerEventsCommands } from "./commands/events.ts";
import { registerProjectCommands } from "./commands/projects.ts";
import { registerSubscriptionsCommands } from "./commands/subscriptions.ts";
import { registerWebhookCommands } from "./commands/webhook.ts";
import { resolveCliConfig, type CliRuntimeConfig } from "./config.ts";
import { ApiError, createHttpClient, NetworkError, type CliHttpClient } from "./http-client.ts";
import { formatApiError, printError, printText } from "./output.ts";

export type GlobalOptions = {
	url: string | undefined;
	token: string | undefined;
	json: boolean | undefined;
	compact: boolean | undefined;
};

export type CommandContext = {
	config: CliRuntimeConfig;
	client: CliHttpClient;
	json: boolean;
	compact: boolean;
};

export type BuildContext = (argv: GlobalOptions) => Promise<CommandContext>;

class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

const buildContext: BuildContext = async (argv) => {
	const config = await resolveCliConfig({
		url: argv.url,
		token: argv.token,
		json: argv.json,
		compact: argv.compact,
	});
	const client = createHttpClient({
		url: config.url,
		...(config.token ? { token: config.token } : {}),
		compact: config.compact,
	});
	return {
		config,
		client,
		json: config.json,
		compact: config.compact,
	};
};

function configureGlobalOptions(parser: Argv): Argv<GlobalOptions> {
	return parser
		.option("url", {
			type: "string",
			describe: "Daemon base URL",
			global: true,
			default: undefined,
		})
		.option("token", {
			type: "string",
			describe: "Bearer token",
			global: true,
			default: undefined,
		})
		.option("json", {
			type: "boolean",
			describe: "Print JSON output",
			global: true,
			default: undefined,
		})
		.option("compact", {
			type: "boolean",
			describe: "Request compact API payloads where supported",
			global: true,
			default: undefined,
		}) as Argv<GlobalOptions>;
}

function renderError(error: unknown): number {
	if (error instanceof UsageError) {
		printError(error.message);
		return 2;
	}
	if (error instanceof ApiError) {
		printError(formatApiError(error.status, error.code, error.message));
		if (error.status === 401) {
			printError("Hint: set --token or AH_TOKEN when daemon auth is enabled.");
		}
		if (error.status === 503 && error.code === "TMUX_UNAVAILABLE") {
			printError("Hint: install tmux or run the daemon on a host where tmux is available.");
		}
		return 1;
	}
	if (error instanceof NetworkError) {
		printError(`Network error: ${error.message}`);
		printError(`Request: ${error.method} ${error.url}`);
		printError("Hint: verify daemon URL (--url/AH_URL) and ensure the daemon is running.");
		return 1;
	}
	const message = error instanceof Error ? error.message : String(error);
	printError(`Error: ${message}`);
	return 1;
}

export async function runCli(argv: readonly string[] = hideBin(process.argv)): Promise<void> {
	const parser = configureGlobalOptions(
		yargs(argv)
			.scriptName("ah")
			.usage("$0 <command> [options]")
			.strict()
			.recommendCommands()
			.help()
			.alias("h", "help")
			.wrap(Math.min(120, yargs().terminalWidth()))
			.exitProcess(false)
			.fail((message, error) => {
				if (error) throw error;
				throw new UsageError(message ?? "Invalid command");
			}),
	);

	registerDaemonCommands(parser, buildContext);
	registerProjectCommands(parser, buildContext);
	registerAgentCommands(parser, buildContext);
	registerEventsCommands(parser, buildContext);
	registerSubscriptionsCommands(parser, buildContext);
	registerWebhookCommands(parser, buildContext);
	registerApiCommands(parser, buildContext);

	parser.command(
		"version",
		"Print version",
		(builder) => builder,
		async () => {
			printText(await getHarnessVersion());
		},
	);

	await parser.demandCommand(1).parseAsync();
}

if (import.meta.main) {
	runCli().catch((error) => {
		const code = renderError(error);
		process.exit(code);
	});
}
