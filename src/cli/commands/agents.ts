import type { Argv } from "yargs";
import type { BuildContext, GlobalOptions } from "../main.ts";
import { printJson, printKeyValue, printTable, printText } from "../output.ts";

function toKeyValueRecord(entries: Array<string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of entries) {
		const separatorIndex = entry.indexOf("=");
		if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
			throw new Error(`Invalid key/value '${entry}'. Expected key=value.`);
		}
		const key = entry.slice(0, separatorIndex).trim();
		const value = entry.slice(separatorIndex + 1).trim();
		if (!key || !value) {
			throw new Error(`Invalid key/value '${entry}'. Expected key=value.`);
		}
		out[key] = value;
	}
	return out;
}

function asString(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	return JSON.stringify(value);
}

function agentIdFromArg(value: string | number): string {
	return String(value);
}

type AgentRecord = {
	id?: unknown;
	status?: unknown;
	tmuxTarget?: unknown;
	attachCommand?: unknown;
	provider?: unknown;
};

type AgentMessageRecord = {
	role?: unknown;
	text?: unknown;
};

type AgentLastResponse = {
	text?: unknown;
	lastAssistantMessage?: unknown;
};

export function registerAgentCommands(
	yargs: Argv<GlobalOptions>,
	buildContext: BuildContext,
): void {
	yargs.command("agents", "Agent management commands", (agents) =>
		agents
			.command(
				"list <project>",
				"List agents in a project",
				(builder) =>
					builder.positional("project", {
						type: "string",
						demandOption: true,
						describe: "Project name",
					}),
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.listAgents(argv.project);
					if (context.json) {
						printJson(response);
						return;
					}
					if (response.agents.length === 0) {
						printText("No agents found.");
						return;
					}
					printTable(
						["ID", "PROVIDER", "STATUS", "TMUX TARGET", "BRIEF"],
						response.agents.map((agent) => [
							agent.id,
							asString(agent.provider),
							asString(agent.status),
							asString(agent.tmuxTarget),
							Array.isArray(agent.brief)
								? agent.brief.filter((item): item is string => typeof item === "string").join(" | ")
								: "",
						]),
					);
				},
			)
			.command(
				"create <project>",
				"Create an agent",
				(builder) =>
					builder
						.positional("project", {
							type: "string",
							demandOption: true,
							describe: "Project name",
						})
						.option("provider", {
							type: "string",
							demandOption: true,
							describe: "Provider name",
						})
						.option("task", {
							type: "string",
							demandOption: true,
							describe: "Initial task prompt",
						})
						.option("name", {
							type: "string",
							describe: "Optional human-readable agent ID",
						})
						.option("model", {
							type: "string",
							describe: "Model override",
						})
						.option("subscription", {
							type: "string",
							describe: "Subscription ID",
						})
						.option("callback-url", {
							type: "string",
							describe: "Webhook callback URL",
						})
						.option("callback-token", {
							type: "string",
							describe: "Webhook callback bearer token",
						})
						.option("discord-channel", {
							type: "string",
							describe: "Callback discord channel",
						})
						.option("session-key", {
							type: "string",
							describe: "Callback session key",
						})
						.option("extra", {
							type: "string",
							array: true,
							describe: "Additional callback values as key=value",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const projectResponse = await context.client.getProject(argv.project);
					const projectCallback = projectResponse.project.callback;
					const extra = toKeyValueRecord(argv.extra ?? []);
					const hasExplicitCallbackOverride =
						argv.callbackUrl !== undefined ||
						argv.callbackToken !== undefined ||
						argv.discordChannel !== undefined ||
						argv.sessionKey !== undefined ||
						Object.keys(extra).length > 0;
					let callback:
						| {
								url: string;
								token?: string;
								discordChannel?: string;
								sessionKey?: string;
								extra?: Record<string, string>;
						  }
						| undefined;
					if (hasExplicitCallbackOverride) {
						if (!argv.callbackUrl) {
							throw new Error(
								"Callback URL is required when setting callback overrides. Set --callback-url.",
							);
						}
						callback = {
							url: argv.callbackUrl,
							...(argv.callbackToken ? { token: argv.callbackToken } : {}),
							...(argv.discordChannel ? { discordChannel: argv.discordChannel } : {}),
							...(argv.sessionKey ? { sessionKey: argv.sessionKey } : {}),
							...(Object.keys(extra).length > 0 ? { extra } : {}),
						};
					} else if (projectCallback?.url) {
						// Let the API apply project callback defaults, including hidden fields such as token.
						callback = undefined;
					} else if (context.config.callbackUrl) {
						callback = {
							url: context.config.callbackUrl,
							...(context.config.callbackToken ? { token: context.config.callbackToken } : {}),
							...(context.config.discordChannel
								? { discordChannel: context.config.discordChannel }
								: {}),
							...(context.config.sessionKey ? { sessionKey: context.config.sessionKey } : {}),
						};
					}
					const response = await context.client.createAgent(argv.project, {
						provider: argv.provider,
						task: argv.task,
						...(argv.name !== undefined ? { name: argv.name } : {}),
						...(argv.model !== undefined ? { model: argv.model } : {}),
						...(argv.subscription !== undefined ? { subscription: argv.subscription } : {}),
						...(callback ? { callback } : {}),
					});
					if (context.json) {
						printJson(response);
						return;
					}

					const created = response.agent as AgentRecord;
					printKeyValue([
						{ key: "id", value: created.id },
						{ key: "status", value: created.status },
						{ key: "tmuxTarget", value: created.tmuxTarget },
						{ key: "attach", value: created.attachCommand },
					]);
				},
			)
			.command(
				"get <project> <agentId>",
				"Get a single agent",
				(builder) =>
					builder
						.positional("project", {
							type: "string",
							demandOption: true,
							describe: "Project name",
						})
						.positional("agentId", {
							type: "string",
							demandOption: true,
							describe: "Agent ID",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.getAgent(
						argv.project,
						agentIdFromArg(argv.agentId),
					);
					if (context.json) {
						printJson(response);
						return;
					}
					const getResponse = response as {
						agent: AgentRecord;
						status?: unknown;
						lastOutput?: unknown;
					};
					const agent = getResponse.agent;
					printKeyValue([
						{ key: "status", value: getResponse.status ?? agent.status },
						{ key: "id", value: agent.id },
						{ key: "provider", value: agent.provider },
						{ key: "tmuxTarget", value: agent.tmuxTarget },
					]);
					const lastOutput = getResponse.lastOutput;
					if (typeof lastOutput === "string" && lastOutput.trim().length > 0) {
						printText("\nLast output:\n");
						printText(lastOutput);
					}
				},
			)
			.command(
				"input <project> <agentId>",
				"Send input to an agent",
				(builder) =>
					builder
						.positional("project", {
							type: "string",
							demandOption: true,
							describe: "Project name",
						})
						.positional("agentId", {
							type: "string",
							demandOption: true,
							describe: "Agent ID",
						})
						.option("text", {
							type: "string",
							demandOption: true,
							describe: "Text to send",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.sendAgentInput(
						argv.project,
						agentIdFromArg(argv.agentId),
						{ text: argv.text },
					);
					if (context.json) {
						printJson(response);
						return;
					}
					printText(`Input delivered: ${response.delivered ? "yes" : "no"}`);
				},
			)
			.command(
				"output <project> <agentId>",
				"Read agent output",
				(builder) =>
					builder
						.positional("project", {
							type: "string",
							demandOption: true,
							describe: "Project name",
						})
						.positional("agentId", {
							type: "string",
							demandOption: true,
							describe: "Agent ID",
						})
						.option("lines", {
							type: "number",
							describe: "Number of lines to capture (1-10000)",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.getAgentOutput(
						argv.project,
						agentIdFromArg(argv.agentId),
						argv.lines,
					);
					if (context.json) {
						printJson(response);
						return;
					}
					printText(response.output);
				},
			)
			.command(
				"messages <project> <agentId>",
				"Get structured provider messages",
				(builder) =>
					builder
						.positional("project", {
							type: "string",
							demandOption: true,
							describe: "Project name",
						})
						.positional("agentId", {
							type: "string",
							demandOption: true,
							describe: "Agent ID",
						})
						.option("limit", {
							type: "number",
							describe: "Max message count (1-500)",
						})
						.option("role", {
							type: "string",
							choices: ["all", "user", "assistant", "system", "developer"] as const,
							describe: "Filter by role",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.getAgentMessages(
						argv.project,
						agentIdFromArg(argv.agentId),
						{
							...(argv.limit !== undefined ? { limit: argv.limit } : {}),
							...(argv.role ? { role: argv.role } : {}),
						},
					);
					if (context.json) {
						printJson(response);
						return;
					}
					const messages = Array.isArray(response.messages) ? response.messages : [];
					printKeyValue([
						{ key: "provider", value: response.provider ?? "unknown" },
						{ key: "source", value: response.source ?? "unknown" },
						{ key: "messages", value: messages.length },
						{ key: "parseErrors", value: response.parseErrorCount ?? 0 },
					]);
					if (messages.length > 0) {
						printText("\nRecent messages:");
						printTable(
							["ROLE", "TEXT"],
							messages.map((rawMessage) => {
								const message = rawMessage as AgentMessageRecord;
								return [
									asString(message.role),
									asString(message.text).replace(/\s+/g, " ").slice(0, 160),
								];
							}),
						);
					}
				},
			)
			.command(
				"last <project> <agentId>",
				"Get latest assistant message",
				(builder) =>
					builder
						.positional("project", {
							type: "string",
							demandOption: true,
							describe: "Project name",
						})
						.positional("agentId", {
							type: "string",
							demandOption: true,
							describe: "Agent ID",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.getAgentLastMessage(
						argv.project,
						agentIdFromArg(argv.agentId),
					);
					if (context.json) {
						printJson(response);
						return;
					}
					const lastResponse = response as AgentLastResponse;
					if (typeof lastResponse.text === "string") {
						printText(lastResponse.text);
						return;
					}
					const lastAssistantMessage = lastResponse.lastAssistantMessage;
					if (
						lastAssistantMessage &&
						typeof lastAssistantMessage === "object" &&
						!Array.isArray(lastAssistantMessage)
					) {
						const assistantMessageRecord = lastAssistantMessage as AgentMessageRecord;
						printText(asString(assistantMessageRecord.text ?? ""));
						return;
					}
					printText("(no assistant message)");
				},
			)
			.command(
				"debug <project> <agentId>",
				"Get agent debug state",
				(builder) =>
					builder
						.positional("project", {
							type: "string",
							demandOption: true,
							describe: "Project name",
						})
						.positional("agentId", {
							type: "string",
							demandOption: true,
							describe: "Agent ID",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.getAgentDebug(
						argv.project,
						agentIdFromArg(argv.agentId),
					);
					if (context.json) {
						printJson(response);
						return;
					}
					printJson(response);
				},
			)
			.command(
				"abort <project> <agentId>",
				"Interrupt an agent",
				(builder) =>
					builder
						.positional("project", {
							type: "string",
							demandOption: true,
							describe: "Project name",
						})
						.positional("agentId", {
							type: "string",
							demandOption: true,
							describe: "Agent ID",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.abortAgent(
						argv.project,
						agentIdFromArg(argv.agentId),
					);
					if (context.json) {
						printJson(response);
						return;
					}
					printText(`Abort signal sent: ${response.sent ? "yes" : "no"}`);
				},
			)
			.command(
				"delete <project> <agentId>",
				"Delete an agent",
				(builder) =>
					builder
						.positional("project", {
							type: "string",
							demandOption: true,
							describe: "Project name",
						})
						.positional("agentId", {
							type: "string",
							demandOption: true,
							describe: "Agent ID",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					await context.client.deleteAgent(argv.project, agentIdFromArg(argv.agentId));
					if (context.json) {
						printJson({ deleted: true, project: argv.project, agentId: argv.agentId });
						return;
					}
					printText(`Deleted agent '${argv.agentId}' in project '${argv.project}'.`);
				},
			)
			.demandCommand(1)
			.strict(),
	);
}
