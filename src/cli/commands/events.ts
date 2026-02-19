import type { Argv } from "yargs";
import { ApiError, NetworkError, readSseFrames } from "../http-client.ts";
import type { BuildContext, GlobalOptions } from "../main.ts";
import { printError, printNdjson, printText } from "../output.ts";

const FILTERABLE_EVENT_TYPES = [
	"agent_started",
	"status_changed",
	"output",
	"tool_use",
	"tool_result",
	"error",
	"agent_exited",
	"input_sent",
	"permission_requested",
	"question_asked",
	"unknown",
	"heartbeat",
] as const;

type FilterableEventType = (typeof FILTERABLE_EVENT_TYPES)[number];

function parsePayload(data: string): Record<string, unknown> | null {
	if (!data || data.trim().length === 0) return null;
	try {
		const parsed = JSON.parse(data);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return { value: parsed };
	} catch {
		return { raw: data };
	}
}

function valueToString(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	return JSON.stringify(value);
}

function trimSummary(value: string, limit = 140): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, limit - 1)}...`;
}

function eventSummary(eventType: string, payload: Record<string, unknown> | null): string {
	if (eventType === "heartbeat") return "heartbeat";
	if (!payload) return "";

	switch (eventType) {
		case "status_changed": {
			const from = valueToString(payload["from"]);
			const to = valueToString(payload["to"]);
			return trimSummary(`${from} -> ${to}`);
		}
		case "output":
			return trimSummary(valueToString(payload["text"]));
		case "tool_use":
			return trimSummary(
				`tool=${valueToString(payload["tool"])} input=${valueToString(payload["input"])}`,
			);
		case "tool_result":
			return trimSummary(
				`tool=${valueToString(payload["tool"])} output=${valueToString(payload["output"])}`,
			);
		case "error":
			return trimSummary(valueToString(payload["message"]));
		case "agent_exited":
			return trimSummary(`exitCode=${valueToString(payload["exitCode"])}`);
		case "input_sent":
			return trimSummary(valueToString(payload["text"]));
		case "permission_requested":
			return trimSummary(valueToString(payload["description"]));
		case "question_asked":
			return trimSummary(valueToString(payload["question"]));
		case "agent_started":
			return trimSummary(`provider=${valueToString(payload["provider"])}`);
		case "unknown":
			return trimSummary(valueToString(payload["raw"]));
		default:
			return trimSummary(
				valueToString(payload["message"] ?? payload["text"] ?? payload["raw"] ?? payload),
			);
	}
}

function isRetryable(error: unknown): boolean {
	if (error instanceof NetworkError) return true;
	if (error instanceof ApiError) {
		if (error.status === 408 || error.status === 429) return true;
		if (error.status >= 500) return true;
		return false;
	}
	return false;
}

function reconnectDelay(attempt: number): number {
	const baseMs = 500;
	const maxMs = 10000;
	const delay = baseMs * 2 ** Math.min(attempt, 6);
	return Math.min(delay, maxMs);
}

export function registerEventsCommands(
	yargs: Argv<GlobalOptions>,
	buildContext: BuildContext,
): void {
	yargs.command("events", "Streaming event commands", (events) =>
		events
			.command(
				"stream",
				"Stream normalized daemon events (SSE)",
				(builder) =>
					builder
						.option("project", {
							type: "string",
							demandOption: true,
							describe: "Project name",
						})
						.option("agent", {
							type: "string",
							describe: "Optional agent ID",
						})
						.option("since", {
							type: "string",
							describe: "Resume from event id (evt-N)",
						})
						.option("type", {
							type: "string",
							array: true,
							choices: FILTERABLE_EVENT_TYPES,
							describe: "Filter by event type (repeatable)",
						})
						.option("show-heartbeats", {
							type: "boolean",
							default: false,
							describe: "Show heartbeat events",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const typeFilter = new Set<FilterableEventType>(argv.type ?? []);
					let since = argv.since;
					let attempt = 0;

					const controller = new AbortController();
					const stop = () => controller.abort();
					process.on("SIGINT", stop);
					process.on("SIGTERM", stop);

					try {
						while (!controller.signal.aborted) {
							try {
								const response = argv.agent
									? await context.client.openAgentEvents(
											argv.project,
											argv.agent,
											since,
											controller.signal,
										)
									: await context.client.openProjectEvents(argv.project, since, controller.signal);

								attempt = 0;
								for await (const frame of readSseFrames(response)) {
									if (controller.signal.aborted) break;
									const eventType = frame.event ?? "message";
									if (eventType === "heartbeat" && !argv.showHeartbeats) {
										if (frame.id) since = frame.id;
										continue;
									}
									if (frame.id) since = frame.id;
									if (typeFilter.size > 0 && !typeFilter.has(eventType as FilterableEventType)) {
										continue;
									}
									const payload = parsePayload(frame.data);
									if (context.json) {
										printNdjson({
											id: frame.id ?? null,
											event: eventType,
											data: payload,
										});
										continue;
									}
									const ts = valueToString(payload?.["ts"] ?? new Date().toISOString());
									const project = valueToString(payload?.["project"] ?? argv.project);
									const agent = valueToString(payload?.["agentId"] ?? argv.agent ?? "-");
									const summary = eventSummary(eventType, payload);
									printText(
										`${ts} ${project}/${agent} ${eventType}${summary ? ` ${summary}` : ""}`,
									);
								}
								if (controller.signal.aborted) break;
								const delay = reconnectDelay(attempt);
								attempt += 1;
								if (!context.json) {
									printError(`events stream disconnected, reconnecting in ${delay}ms`);
								}
								await Bun.sleep(delay);
							} catch (error) {
								if (controller.signal.aborted) break;
								if (!isRetryable(error)) {
									throw error;
								}
								const delay = reconnectDelay(attempt);
								attempt += 1;
								if (!context.json) {
									const message = error instanceof Error ? error.message : String(error);
									printError(`events stream error: ${message} (retry in ${delay}ms)`);
								}
								await Bun.sleep(delay);
							}
						}
					} finally {
						process.off("SIGINT", stop);
						process.off("SIGTERM", stop);
					}
				},
			)
			.demandCommand(1)
			.strict(),
	);
}
