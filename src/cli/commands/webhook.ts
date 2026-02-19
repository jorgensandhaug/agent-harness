import type { Argv } from "yargs";
import type { BuildContext, GlobalOptions } from "../main.ts";
import { printJson, printKeyValue, printText } from "../output.ts";

type WebhookStatusResponseView = {
	configured?: unknown;
	status?: unknown;
};

type WebhookStatusView = {
	config?: unknown;
};

type WebhookStatusConfigView = {
	url?: unknown;
};

function parseExtra(entries: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of entries) {
		const separatorIndex = entry.indexOf("=");
		if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
			throw new Error(`Invalid --extra '${entry}'. Expected key=value.`);
		}
		const key = entry.slice(0, separatorIndex).trim();
		const value = entry.slice(separatorIndex + 1).trim();
		if (!key || !value) {
			throw new Error(`Invalid --extra '${entry}'. Expected key=value.`);
		}
		out[key] = value;
	}
	return out;
}

export function registerWebhookCommands(
	yargs: Argv<GlobalOptions>,
	buildContext: BuildContext,
): void {
	yargs.command("webhook", "Webhook utility commands", (webhook) =>
		webhook
			.command(
				"status",
				"Show webhook client status",
				(builder) => builder,
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.webhookStatus();
					const statusResponse = response as WebhookStatusResponseView;
					if (context.json) {
						printJson(response);
						return;
					}
					if (statusResponse.configured === false) {
						printText("Webhook not configured.");
						return;
					}
					const status =
						statusResponse.status &&
						typeof statusResponse.status === "object" &&
						!Array.isArray(statusResponse.status)
							? (statusResponse.status as WebhookStatusView)
							: null;
					const statusConfig =
						status?.config && typeof status.config === "object" && !Array.isArray(status.config)
							? (status.config as WebhookStatusConfigView)
							: null;
					printKeyValue([
						{ key: "configured", value: statusResponse.configured },
						{ key: "url", value: statusConfig?.url ?? "" },
					]);
				},
			)
			.command(
				"test",
				"Send a test webhook",
				(builder) =>
					builder
						.option("event", {
							type: "string",
							choices: ["agent_completed", "agent_error", "agent_exited"] as const,
							describe: "Event type",
						})
						.option("project", {
							type: "string",
							describe: "Project name",
						})
						.option("agent-id", {
							type: "string",
							describe: "Agent ID",
						})
						.option("provider", {
							type: "string",
							describe: "Provider",
						})
						.option("status", {
							type: "string",
							describe: "Agent status",
						})
						.option("last-message", {
							type: "string",
							describe: "Last message override",
						})
						.option("last-message-null", {
							type: "boolean",
							default: false,
							describe: "Send explicit null for lastMessage",
						})
						.option("target-url", {
							type: "string",
							describe: "Override webhook URL",
						})
						.option("target-token", {
							type: "string",
							describe: "Override webhook token",
						})
						.option("discord-channel", {
							type: "string",
							describe: "Discord channel override",
						})
						.option("session-key", {
							type: "string",
							describe: "Session key override",
						})
						.option("extra", {
							type: "string",
							array: true,
							describe: "Extra key=value metadata",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					if (argv.lastMessage !== undefined && argv.lastMessageNull) {
						throw new Error("Use either --last-message or --last-message-null, not both.");
					}
					const extra = parseExtra(argv.extra ?? []);
					const response = await context.client.webhookTest({
						...(argv.event ? { event: argv.event } : {}),
						...(argv.project ? { project: argv.project } : {}),
						...(argv.agentId ? { agentId: argv.agentId } : {}),
						...(argv.provider ? { provider: argv.provider } : {}),
						...(argv.status ? { status: argv.status } : {}),
						...(argv.lastMessageNull ? { lastMessage: null } : {}),
						...(argv.lastMessage ? { lastMessage: argv.lastMessage } : {}),
						...(argv.targetUrl ? { url: argv.targetUrl } : {}),
						...(argv.targetToken ? { token: argv.targetToken } : {}),
						...(argv.discordChannel ? { discordChannel: argv.discordChannel } : {}),
						...(argv.sessionKey ? { sessionKey: argv.sessionKey } : {}),
						...(Object.keys(extra).length > 0 ? { extra } : {}),
					});
					if (context.json) {
						printJson(response);
						return;
					}
					printText("Webhook test sent.");
					printJson(response);
				},
			)
			.command(
				"probe",
				"Probe a webhook receiver",
				(builder) =>
					builder.option("base-url", {
						type: "string",
						describe: "Override receiver base URL",
					}),
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.webhookProbe(argv.baseUrl);
					if (context.json) {
						printJson(response);
						return;
					}
					printJson(response);
				},
			)
			.demandCommand(1)
			.strict(),
	);
}
