import { Hono } from "hono";
import { z } from "zod";

const WebhookEventSchema = z.enum(["agent_completed", "agent_error", "agent_exited"]);

const WebhookPayloadSchema = z
	.object({
		event: WebhookEventSchema,
		project: z.string().min(1),
		agentId: z.string().min(1),
		provider: z.string().min(1),
		status: z.string().min(1),
		lastMessage: z.string().nullable(),
		timestamp: z.string().datetime(),
		discordChannel: z.string().min(1).optional(),
		sessionKey: z.string().min(1).optional(),
		extra: z.record(z.string()).optional(),
	})
	.strict();

const ReceiverConfigSchema = z
	.object({
		port: z.number().int().min(1).max(65535),
		bindAddress: z.string().min(1).default("127.0.0.1"),
		token: z.string().min(1).optional(),
		discordWebhookUrl: z.string().url().optional(),
		openclawCommand: z.string().min(1).default("openclaw"),
		openclawArgs: z.array(z.string().min(1)).default(["system", "event"]),
		openclawTimeoutMs: z.number().int().min(100).max(120000).default(5000),
	})
	.strict();

type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;
export type ReceiverConfig = z.infer<typeof ReceiverConfigSchema>;

type EnvSource = Readonly<{
	AH_WEBHOOK_RECEIVER_PORT?: string;
	AH_WEBHOOK_RECEIVER_BIND_ADDRESS?: string;
	AH_WEBHOOK_RECEIVER_TOKEN?: string;
	AH_DISCORD_WEBHOOK_URL?: string;
	AH_WEBHOOK_RECEIVER_DISCORD_WEBHOOK_URL?: string;
	AH_WEBHOOK_RECEIVER_OPENCLAW_BIN?: string;
	AH_WEBHOOK_RECEIVER_OPENCLAW_ARGS?: string;
	AH_WEBHOOK_RECEIVER_OPENCLAW_TIMEOUT_MS?: string;
}>;

function receiverLog(
	level: "info" | "warn" | "error",
	msg: string,
	extra: Record<string, unknown> = {},
): void {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			level,
			msg,
			...extra,
		}),
	);
}

function parseCsv(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const items = value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return items.length > 0 ? items : undefined;
}

function parseIntWithDefault(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: EnvSource = process.env as EnvSource): ReceiverConfig {
	const parsed = ReceiverConfigSchema.safeParse({
		port: parseIntWithDefault(env.AH_WEBHOOK_RECEIVER_PORT, 7071),
		bindAddress: env.AH_WEBHOOK_RECEIVER_BIND_ADDRESS?.trim() || "127.0.0.1",
		token: env.AH_WEBHOOK_RECEIVER_TOKEN?.trim() || undefined,
		discordWebhookUrl:
			env.AH_DISCORD_WEBHOOK_URL?.trim() ||
			env.AH_WEBHOOK_RECEIVER_DISCORD_WEBHOOK_URL?.trim() ||
			undefined,
		openclawCommand: env.AH_WEBHOOK_RECEIVER_OPENCLAW_BIN?.trim() || "openclaw",
		openclawArgs: parseCsv(env.AH_WEBHOOK_RECEIVER_OPENCLAW_ARGS) ?? ["system", "event"],
		openclawTimeoutMs: parseIntWithDefault(env.AH_WEBHOOK_RECEIVER_OPENCLAW_TIMEOUT_MS, 5000),
	});

	if (parsed.success) return parsed.data;
	const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
	throw new Error(`Invalid webhook receiver config: ${issues.join("; ")}`);
}

export function matchesBearerToken(authHeader: string | undefined, expectedToken: string): boolean {
	if (!authHeader) return false;
	const prefix = "Bearer ";
	if (!authHeader.startsWith(prefix)) return false;
	const token = authHeader.slice(prefix.length);
	return token === expectedToken;
}

export function formatEventMessage(payload: WebhookPayload): string {
	const header = `[${payload.event}] project=${payload.project} agent=${payload.agentId} provider=${payload.provider} status=${payload.status}${payload.discordChannel ? ` discordChannel=${payload.discordChannel}` : ""}${payload.sessionKey ? ` sessionKey=${payload.sessionKey}` : ""}`;
	const extraEntries = payload.extra ? Object.entries(payload.extra) : [];
	const extraLine =
		extraEntries.length > 0
			? `extra=${extraEntries
					.map(([key, value]) => `${key}=${value}`)
					.sort()
					.join(",")}`
			: "";
	const tail = typeof payload.lastMessage === "string" ? payload.lastMessage.trim() : "";
	if (!tail && !extraLine) return header;
	if (!tail) return `${header}\n${extraLine}`;
	if (!extraLine) return `${header}\n${tail.slice(0, 1200)}`;
	return `${header}\n${extraLine}\n${tail.slice(0, 1200)}`;
}

async function runDiscordWebhookAction(url: string, payload: WebhookPayload): Promise<void> {
	const body = {
		content: formatEventMessage(payload),
	};
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10000),
	});
	if (!response.ok) {
		throw new Error(`discord webhook http ${response.status}`);
	}
}

async function readStreamText(stream: ReadableStream<Uint8Array> | number | null): Promise<string> {
	if (!stream || typeof stream === "number") return "";
	return new Response(stream).text();
}

async function runOpenClawAction(config: ReceiverConfig, payload: WebhookPayload): Promise<void> {
	const message = formatEventMessage(payload);
	const cmd = [config.openclawCommand, ...config.openclawArgs, message];
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
	});

	const timeout = new Promise<"timeout">((resolve) => {
		setTimeout(() => resolve("timeout"), config.openclawTimeoutMs);
	});

	const exitOrTimeout = await Promise.race([proc.exited, timeout]);
	if (exitOrTimeout === "timeout") {
		proc.kill();
		throw new Error(`openclaw command timed out after ${config.openclawTimeoutMs}ms`);
	}
	if (exitOrTimeout !== 0) {
		const stderr = (await readStreamText(proc.stderr)).trim();
		throw new Error(`openclaw command failed (${exitOrTimeout})${stderr ? `: ${stderr}` : ""}`);
	}
}

export async function runActions(config: ReceiverConfig, payload: WebhookPayload): Promise<void> {
	if (payload.discordChannel) {
		if (!config.discordWebhookUrl) {
			receiverLog("warn", "discord routing requested but AH_DISCORD_WEBHOOK_URL not configured", {
				discordChannel: payload.discordChannel,
			});
		} else {
			try {
				await runDiscordWebhookAction(config.discordWebhookUrl, payload);
			} catch (error) {
				receiverLog("warn", "receiver discord action failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	if (payload.sessionKey) {
		try {
			await runOpenClawAction(config, payload);
		} catch (error) {
			receiverLog("warn", "receiver openclaw action failed", {
				error: error instanceof Error ? error.message : String(error),
				sessionKey: payload.sessionKey,
			});
		}
	}

	if (!payload.discordChannel && !payload.sessionKey) {
		receiverLog("info", "received webhook event without routing fields", {
			payload,
		});
	}
}

export function createReceiverApp(config: ReceiverConfig): Hono {
	const app = new Hono();

	app.get("/health", (c) => c.json({ ok: true }));

	app.post("/harness-webhook", async (c) => {
		if (config.token && !matchesBearerToken(c.req.header("authorization"), config.token)) {
			return c.json({ error: "unauthorized" }, 401);
		}

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}

		const parsed = WebhookPayloadSchema.safeParse(body);
		if (!parsed.success) {
			const issues = parsed.error.issues.map((issue) => ({
				path: issue.path.join("."),
				message: issue.message,
			}));
			return c.json({ error: "invalid_payload", issues }, 400);
		}

		await runActions(config, parsed.data);
		return c.json({ ok: true });
	});

	return app;
}

export function startWebhookReceiver(config: ReceiverConfig): ReturnType<typeof Bun.serve> {
	const app = createReceiverApp(config);
	const server = Bun.serve({
		port: config.port,
		hostname: config.bindAddress,
		fetch: app.fetch,
		idleTimeout: 120,
	});
	receiverLog("info", "webhook receiver started", {
		port: server.port,
		bindAddress: config.bindAddress,
		tokenRequired: Boolean(config.token),
		discordWebhookConfigured: Boolean(config.discordWebhookUrl),
		openclawCommand: config.openclawCommand,
	});
	return server;
}

if (import.meta.main) {
	const config = loadConfig();
	const server = startWebhookReceiver(config);

	const shutdown = () => {
		server.stop(true);
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
