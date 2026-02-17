import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { HarnessConfig } from "./config.ts";
import { createEventBus } from "./events/bus.ts";
import { createPoller } from "./poller/poller.ts";
import { createManager } from "./session/manager.ts";
import { createStore } from "./session/store.ts";
import { createApp } from "./api/app.ts";

type ProviderName = "claude-code" | "codex" | "pi" | "opencode";

type CliOptions = {
	provider: ProviderName;
	prompt: string;
	all: boolean;
	help: boolean;
};

type SseEvent = {
	id?: string;
	event?: string;
	data?: string;
};

const STATUS_COLORS: Record<string, string> = {
	idle: "\x1b[32m",
	processing: "\x1b[33m",
	waiting_input: "\x1b[35m",
	error: "\x1b[31m",
	exited: "\x1b[90m",
	starting: "\x1b[36m",
};

const RESET = "\x1b[0m";
const DEFAULT_PROMPT = "Reply with exactly: 4";
const HARD_TIMEOUT_MS = 90_000;
const SNAPSHOT_LINES = 20;

function nowHms(): string {
	return new Date().toTimeString().slice(0, 8);
}

function shortPayload(event: SseEvent): string {
	if (!event.data) return "";
	try {
		const parsed = JSON.parse(event.data) as Record<string, unknown>;
		if (typeof parsed.text === "string") return parsed.text.slice(0, 80);
		if (typeof parsed.message === "string") return parsed.message.slice(0, 80);
		if (typeof parsed.description === "string") return parsed.description.slice(0, 80);
		if (typeof parsed.question === "string") return parsed.question.slice(0, 80);
		return JSON.stringify(parsed).slice(0, 80);
	} catch {
		return event.data.slice(0, 80);
	}
}

function colorStatus(status: string): string {
	const color = STATUS_COLORS[status] ?? "";
	return `${color}${status}${RESET}`;
}

function parseArgs(argv: readonly string[]): CliOptions {
	let provider: ProviderName = "claude-code";
	let prompt = DEFAULT_PROMPT;
	let all = false;
	let help = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--provider" && argv[i + 1]) {
			const val = argv[i + 1] as ProviderName;
			if (val === "claude-code" || val === "codex" || val === "pi" || val === "opencode") {
				provider = val;
			}
			i++;
			continue;
		}
		if (arg === "--prompt" && argv[i + 1]) {
			prompt = argv[i + 1] ?? DEFAULT_PROMPT;
			i++;
			continue;
		}
		if (arg === "--all") {
			all = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
		}
	}

	return { provider, prompt, all, help };
}

function makeConfig(prefix: string): HarnessConfig {
	return {
		port: 0,
		tmuxPrefix: prefix,
		logDir: "./logs",
		logLevel: "info",
		pollIntervalMs: 500,
		captureLines: 200,
		maxEventHistory: 5000,
		providers: {
			"claude-code": {
				command: "claude",
				extraArgs: ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions"],
				env: {},
				model: process.env.TEST_MODEL_CLAUDE,
				enabled: true,
			},
			codex: {
				command: "codex",
				extraArgs: ["--yolo", "--dangerously-bypass-approvals-and-sandbox"],
				env: {},
				model: process.env.TEST_MODEL_CODEX,
				enabled: true,
			},
			pi: {
				command: "pi",
				extraArgs: [],
				env: {},
				model: process.env.TEST_MODEL_PI,
				enabled: true,
			},
			opencode: {
				command: "opencode",
				extraArgs: [],
				env: {},
				model: process.env.TEST_MODEL_OPENCODE,
				enabled: true,
			},
		},
	};
}

async function api(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
	return fetch(`${baseUrl}${path}`, {
		headers: { "content-type": "application/json" },
		...init,
	});
}

async function readSseFrame(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	state: { buffer: string },
): Promise<SseEvent | null> {
	const decoder = new TextDecoder();
	while (true) {
		const sep = state.buffer.indexOf("\n\n");
		if (sep !== -1) {
			const frame = state.buffer.slice(0, sep);
			state.buffer = state.buffer.slice(sep + 2);
			const out: SseEvent = {};
			for (const raw of frame.split("\n")) {
				const line = raw.replace(/\r$/, "");
				if (line.startsWith("id: ")) out.id = line.slice(4);
				if (line.startsWith("event: ")) out.event = line.slice(7);
				if (line.startsWith("data: ")) out.data = line.slice(6);
			}
			return out;
		}

		const next = await reader.read();
		if (next.done) return null;
		state.buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, "\n");
	}
}

async function runProvider(provider: ProviderName, prompt: string): Promise<void> {
	const startTime = Date.now();
	const tmuxPrefix = `ah-smoke-${provider}-${Date.now()}`;
	const config = makeConfig(tmuxPrefix);
	const store = createStore();
	const eventBus = createEventBus(config.maxEventHistory);
	const manager = createManager(config, store, eventBus);
	const poller = createPoller(config, store, manager, eventBus);
	poller.start();
	const app = createApp(manager, store, eventBus, startTime);
	const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 120 });
	const baseUrl = `http://127.0.0.1:${server.port}`;
	const project = `smoke-${provider}-${Date.now()}`;

	let agentId = "";
	let tmuxTarget = "";
	let currentStatus = "starting";
	let lastTransitionTs = nowHms();
	let lastOutput = "";
	const feed: string[] = [];
	let quit = false;
	let timedOut = false;
	const onFeed = (line: string) => {
		feed.push(line);
		if (feed.length > 40) feed.splice(0, feed.length - 40);
	};

	let cleanupDelete = true;
	let inputHandler: ((chunk: Buffer) => void) | null = null;
	const sseAbort = new AbortController();
	let snapshotTimer: ReturnType<typeof setInterval> | null = null;
	const timeoutTimer = setTimeout(() => {
		timedOut = true;
		onFeed(`[${nowHms()}] timeout 90s reached`);
		quit = true;
	}, HARD_TIMEOUT_MS);

	try {
		const createProject = await api(baseUrl, "/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ name: project, cwd: process.cwd() }),
		});
		if (!createProject.ok) {
			throw new Error(`project create failed: ${createProject.status} ${await createProject.text()}`);
		}

		const modelEnvName =
			provider === "claude-code"
				? "TEST_MODEL_CLAUDE"
				: provider === "codex"
					? "TEST_MODEL_CODEX"
					: provider === "pi"
						? "TEST_MODEL_PI"
						: "TEST_MODEL_OPENCODE";
		const model = process.env[modelEnvName];

		const createAgent = await api(baseUrl, `/api/v1/projects/${project}/agents`, {
			method: "POST",
			body: JSON.stringify({ provider, task: prompt, model }),
		});
		if (!createAgent.ok) {
			throw new Error(`agent create failed: ${createAgent.status} ${await createAgent.text()}`);
		}
		const createAgentJson = (await createAgent.json()) as {
			agent: { id: string; tmuxTarget: string; status: string };
		};
		agentId = createAgentJson.agent.id;
		tmuxTarget = createAgentJson.agent.tmuxTarget;
		currentStatus = createAgentJson.agent.status;

		output.write(`\nAttach now: tmux attach -t ${tmuxTarget.split(":")[0]}\n`);
		output.write("Press q or Ctrl-C to quit visual smoke view.\n\n");

		const sseResponse = await fetch(
			`${baseUrl}/api/v1/projects/${project}/agents/${agentId}/events`,
			{ headers: { accept: "text/event-stream" }, signal: sseAbort.signal },
		);
		if (!sseResponse.ok || !sseResponse.body) {
			throw new Error(`sse subscribe failed: ${sseResponse.status}`);
		}
		const sseReader = sseResponse.body.getReader();
		const sseState = { buffer: "" };

		const render = () => {
			output.write("\x1b[2J\x1b[H");
			output.write(`Provider: ${provider}\n`);
			output.write(`Project: ${project}\n`);
			output.write(`Agent: ${agentId}\n`);
			output.write(`Tmux target: ${tmuxTarget}\n`);
			output.write(`Status: ${colorStatus(currentStatus)} (${currentStatus})\n`);
			output.write(`Last transition: ${lastTransitionTs}\n`);
			output.write("\nEvents:\n");
			for (const line of feed.slice(-12)) {
				output.write(`${line}\n`);
			}
			output.write("\n--- Output Snapshot ---\n");
			const lines = lastOutput.split("\n").slice(-SNAPSHOT_LINES);
			for (const line of lines) {
				output.write(`${line}\n`);
			}
			output.write("\n(q/Ctrl-C to quit)\n");
		};

		snapshotTimer = setInterval(async () => {
			if (quit) return;
			const getAgent = await fetch(`${baseUrl}/api/v1/projects/${project}/agents/${agentId}`);
			if (getAgent.ok) {
				const json = (await getAgent.json()) as { status: string };
				if (json.status !== currentStatus) {
					onFeed(`[${nowHms()}] STATUS ${currentStatus} -> ${json.status}`);
					currentStatus = json.status;
					lastTransitionTs = nowHms();
				}
			}

			const outRes = await fetch(
				`${baseUrl}/api/v1/projects/${project}/agents/${agentId}/output?lines=${SNAPSHOT_LINES}`,
			);
			if (outRes.ok) {
				const json = (await outRes.json()) as { output: string };
				lastOutput = json.output;
			}

			render();
		}, 2000);

		if (input.isTTY) {
			input.setRawMode(true);
		}
		input.resume();
		inputHandler = (chunk: Buffer) => {
			const key = chunk.toString("utf8");
			if (key === "q" || key === "Q" || key === "\u0003") {
				quit = true;
			}
		};
		input.on("data", inputHandler);

		while (!quit) {
			const evt = await readSseFrame(sseReader, sseState);
			if (!evt) break;
			if (!evt.event || evt.event === "heartbeat") continue;

			if (evt.event === "status_changed" && evt.data) {
				try {
					const parsed = JSON.parse(evt.data) as { from: string; to: string };
					onFeed(`[${nowHms()}] STATUS ${parsed.from} -> ${parsed.to}`);
					currentStatus = parsed.to;
					lastTransitionTs = nowHms();
				} catch {
					onFeed(`[${nowHms()}] status_changed ${shortPayload(evt)}`);
				}
			} else {
				onFeed(`[${nowHms()}] ${evt.event} ${shortPayload(evt)}`);
			}
		}

		if (inputHandler) {
			input.off("data", inputHandler);
			inputHandler = null;
		}
		if (input.isTTY) {
			input.setRawMode(false);
		}

		const rl = createInterface({ input, output });
		const answer = await rl.question(
			timedOut
				? "Timed out. cleanup? [d]elete/[k]eep session: "
				: "cleanup? [d]elete/[k]eep session: ",
		);
		rl.close();
		cleanupDelete = !/^k/i.test(answer.trim());
	} finally {
		clearTimeout(timeoutTimer);
		if (snapshotTimer) {
			clearInterval(snapshotTimer);
			snapshotTimer = null;
		}
		sseAbort.abort();
		if (inputHandler) {
			input.off("data", inputHandler);
		}
		if (input.isTTY) {
			input.setRawMode(false);
		}

		if (cleanupDelete && agentId) {
			await fetch(`${baseUrl}/api/v1/projects/${project}/agents/${agentId}`, { method: "DELETE" });
		}
		if (cleanupDelete) {
			await fetch(`${baseUrl}/api/v1/projects/${project}`, { method: "DELETE" });
		} else {
			output.write(`Kept tmux session. Attach: tmux attach -t ${tmuxTarget.split(":")[0]}\n`);
		}

		poller.stop();
		server.stop(true);
	}
}

function printHelp(): void {
	output.write("Usage: bun run smoke [--provider <claude-code|codex|pi|opencode>] [--prompt <text>] [--all]\n");
	output.write("Examples:\n");
	output.write("  bun run smoke\n");
	output.write("  bun run smoke -- --provider codex\n");
	output.write("  bun run smoke -- --prompt 'Reply with exactly: 4'\n");
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		printHelp();
		return;
	}

	if (opts.all) {
		for (const provider of ["claude-code", "codex", "pi", "opencode"] as const) {
			await runProvider(provider, opts.prompt);
		}
		return;
	}

	await runProvider(opts.provider, opts.prompt);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`smoke failed: ${message}\n`);
	process.exit(1);
});
