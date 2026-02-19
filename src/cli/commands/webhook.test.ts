import { describe, expect, it } from "bun:test";
import yargs from "yargs";
import type { CliHttpClient, WebhookTestRequest } from "../http-client.ts";
import type { BuildContext, CommandContext, GlobalOptions } from "../main.ts";
import { registerWebhookCommands } from "./webhook.ts";

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

describe("cli/commands/webhook.test", () => {
	it("sends explicit null lastMessage", async () => {
		const webhookCalls: WebhookTestRequest[] = [];
		const client = {
			async webhookTest(input?: WebhookTestRequest) {
				webhookCalls.push(input ?? {});
				return { ok: true };
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
		registerWebhookCommands(parser, buildContext);
		await parser.parseAsync(["webhook", "test", "--last-message-null"]);

		expect(webhookCalls).toEqual([{ lastMessage: null }]);
	});

	it("rejects --last-message with --last-message-null", async () => {
		const client = {
			async webhookTest(_input?: WebhookTestRequest) {
				return { ok: true };
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
		registerWebhookCommands(parser, buildContext);

		await expect(
			parser.parseAsync(["webhook", "test", "--last-message", "hello", "--last-message-null"]),
		).rejects.toThrow("Use either --last-message or --last-message-null, not both.");
	});
});
