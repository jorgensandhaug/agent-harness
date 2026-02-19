import type { Argv } from "yargs";
import type { BuildContext, GlobalOptions } from "../main.ts";
import { printJson, printKeyValue, printText } from "../output.ts";

function parsePairs(entries: string[], label: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of entries) {
		const separatorIndex = entry.indexOf("=");
		if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
			throw new Error(`Invalid ${label} '${entry}'. Expected key=value.`);
		}
		const key = entry.slice(0, separatorIndex).trim();
		const value = entry.slice(separatorIndex + 1).trim();
		if (!key || !value) {
			throw new Error(`Invalid ${label} '${entry}'. Expected key=value.`);
		}
		out[key] = value;
	}
	return out;
}

function parseHeaders(entries: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of entries) {
		const separatorIndex = entry.indexOf(":");
		if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
			throw new Error(`Invalid header '${entry}'. Expected Name: Value.`);
		}
		const key = entry.slice(0, separatorIndex).trim();
		const value = entry.slice(separatorIndex + 1).trim();
		if (!key || !value) {
			throw new Error(`Invalid header '${entry}'. Expected Name: Value.`);
		}
		out[key] = value;
	}
	return out;
}

function parseBody(bodyRaw: string | undefined): unknown {
	if (!bodyRaw) return undefined;
	try {
		return JSON.parse(bodyRaw);
	} catch {
		throw new Error("--body must be valid JSON");
	}
}

export function registerApiCommands(yargs: Argv<GlobalOptions>, buildContext: BuildContext): void {
	yargs.command("api", "Raw API escape hatch", (api) =>
		api
			.command(
				"request <method> <path>",
				"Send a raw HTTP request",
				(builder) =>
					builder
						.positional("method", {
							type: "string",
							demandOption: true,
							describe: "HTTP method",
						})
						.positional("path", {
							type: "string",
							demandOption: true,
							describe: "Path like /api/v1/health",
						})
						.option("query", {
							type: "string",
							array: true,
							describe: "Query pair key=value (repeatable)",
						})
						.option("header", {
							type: "string",
							array: true,
							describe: "Header Name: Value (repeatable)",
						})
						.option("body", {
							type: "string",
							describe: "JSON request body",
						})
						.option("timeout-ms", {
							type: "number",
							describe: "Request timeout in milliseconds",
						}),
				async (argv) => {
					const context = await buildContext(argv);
					const response = await context.client.rawRequest({
						method: argv.method,
						path: argv.path,
						query: parsePairs(argv.query ?? [], "query"),
						headers: parseHeaders(argv.header ?? []),
						body: parseBody(argv.body),
						...(argv.timeoutMs !== undefined ? { timeoutMs: argv.timeoutMs } : {}),
					});

					if (context.json) {
						printJson(response);
						if (response.status >= 400) process.exitCode = 1;
						return;
					}

					printKeyValue([
						{ key: "status", value: response.status },
						{ key: "content-type", value: response.contentType ?? "" },
					]);
					if (response.json !== null) {
						printText("");
						printJson(response.json);
					} else if (response.text !== null) {
						printText("");
						printText(response.text);
					}
					if (response.status >= 400) process.exitCode = 1;
				},
			)
			.demandCommand(1)
			.strict(),
	);
}
