import { loadConfig } from "./config.ts";
import { serveCommand } from "./serve.ts";
import { getHarnessVersion } from "./version.ts";

type HealthResponse = {
	uptime?: unknown;
	projects?: unknown;
	agents?: unknown;
	tmuxAvailable?: unknown;
	version?: unknown;
};

function usage(): string {
	return [
		"Usage: agent-harness <command>",
		"",
		"Commands:",
		"  serve    Start daemon",
		"  status   Check daemon health",
		"  version  Print version",
	].join("\n");
}

async function statusCommand(): Promise<void> {
	const config = await loadConfig();
	const url = `http://127.0.0.1:${config.port}/api/v1/health`;
	const timeoutMs = 2000;

	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			console.log(`status: down (http ${response.status})`);
			console.log(`url: ${url}`);
			process.exit(1);
			return;
		}

		const json = (await response.json()) as HealthResponse;
		const uptime = typeof json.uptime === "number" ? json.uptime : null;
		const projects = typeof json.projects === "number" ? json.projects : null;
		const agents = typeof json.agents === "number" ? json.agents : null;
		const tmuxAvailable = typeof json.tmuxAvailable === "boolean" ? json.tmuxAvailable : null;
		const version = typeof json.version === "string" ? json.version : await getHarnessVersion();

		console.log("status: running");
		console.log(`url: ${url}`);
		console.log(`uptime: ${uptime ?? "unknown"}s`);
		console.log(`projects: ${projects ?? "unknown"}`);
		console.log(`agents: ${agents ?? "unknown"}`);
		console.log(
			`tmux: ${tmuxAvailable === null ? "unknown" : tmuxAvailable ? "available" : "unavailable"}`,
		);
		console.log(`version: ${version}`);
	} catch {
		console.log("status: down");
		console.log(`url: ${url}`);
		process.exit(1);
	}
}

async function versionCommand(): Promise<void> {
	console.log(await getHarnessVersion());
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	const command = argv[0] ?? "serve";
	if (command === "serve") {
		await serveCommand();
		return;
	}
	if (command === "status") {
		await statusCommand();
		return;
	}
	if (command === "version") {
		await versionCommand();
		return;
	}
	if (command === "help" || command === "--help" || command === "-h") {
		console.log(usage());
		return;
	}

	console.error(`Unknown command: ${command}`);
	console.error("");
	console.error(usage());
	process.exit(1);
}

if (import.meta.main) {
	runCli().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`error: ${message}`);
		process.exit(1);
	});
}
