import type { Argv } from "yargs";
import type { BuildContext, GlobalOptions } from "../main.ts";
import { printJson, printTable, printText } from "../output.ts";

type SubscriptionRecord = {
	id?: unknown;
	mode?: unknown;
	valid?: unknown;
	source?: unknown;
	reason?: unknown;
	subscription?: unknown;
};

type SubscriptionSource = {
	provider?: unknown;
};

function getString(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

function getBoolean(value: unknown): string {
	if (typeof value === "boolean") return value ? "yes" : "no";
	return "";
}

export function registerSubscriptionsCommands(
	yargs: Argv<GlobalOptions>,
	buildContext: BuildContext,
): void {
	yargs.command("subscriptions", "Subscription discovery and validation", (subscriptions) =>
		subscriptions
			.command(
				"list",
				"List subscriptions",
				(builder) => builder,
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.listSubscriptions();
					if (context.json) {
						printJson(response);
						return;
					}
					if (response.subscriptions.length === 0) {
						printText("No subscriptions found.");
						return;
					}
					printTable(
						["ID", "PROVIDER", "MODE", "VALID", "SOURCE", "REASON"],
						response.subscriptions.map((rawSubscription) => {
							const subscription = rawSubscription as SubscriptionRecord;
							let sourceRecord: SubscriptionSource = {};
							if (
								subscription.subscription &&
								typeof subscription.subscription === "object" &&
								!Array.isArray(subscription.subscription)
							) {
								sourceRecord = subscription.subscription as SubscriptionSource;
							}
							return [
								getString(subscription.id),
								getString(sourceRecord.provider),
								getString(subscription.mode),
								getBoolean(subscription.valid),
								getString(subscription.source),
								getString(subscription.reason),
							];
						}),
					);
				},
			)
			.demandCommand(1)
			.strict(),
	);
}
