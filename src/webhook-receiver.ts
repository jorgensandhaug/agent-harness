import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
		discordBotToken: z.string().min(1),
	})
	.strict();

type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;
export type ReceiverConfig = z.infer<typeof ReceiverConfigSchema>;
type ReceiverFileConfig = Partial<ReceiverConfig>;
const DISCORD_INLINE_CHAR_LIMIT = 250;

type EnvSource = Readonly<{
	AH_WEBHOOK_RECEIVER_CONFIG?: string;
	AH_WEBHOOK_RECEIVER_PORT?: string;
	AH_WEBHOOK_RECEIVER_BIND_ADDRESS?: string;
	AH_WEBHOOK_RECEIVER_TOKEN?: string;
	AH_WEBHOOK_RECEIVER_DISCORD_BOT_TOKEN?: string;
	XDG_CONFIG_HOME?: string;
	HOME?: string;
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

function parseIntWithDefault(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function defaultReceiverConfigCandidates(env: EnvSource): string[] {
	const xdgConfigHome = nonEmpty(env.XDG_CONFIG_HOME);
	const homeDir = nonEmpty(env.HOME);
	if (xdgConfigHome) {
		return [join(xdgConfigHome, "agent-harness", "webhook-receiver.json"), "webhook-receiver.json"];
	}
	if (homeDir) {
		return [
			join(homeDir, ".config", "agent-harness", "webhook-receiver.json"),
			"webhook-receiver.json",
		];
	}
	return ["webhook-receiver.json"];
}

function resolveReceiverConfigPath(env: EnvSource): string {
	const explicitPath = nonEmpty(env.AH_WEBHOOK_RECEIVER_CONFIG);
	if (explicitPath) return explicitPath;

	const candidates = defaultReceiverConfigCandidates(env);
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[0] ?? "webhook-receiver.json";
}

function readReceiverFileConfig(path: string): ReceiverFileConfig {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			receiverLog("info", "receiver config loaded", { path });
			return raw as ReceiverFileConfig;
		}
		receiverLog("warn", "receiver config must be a JSON object, ignoring file", { path });
		return {};
	} catch (error) {
		receiverLog("warn", "failed to read receiver config file, ignoring file", {
			path,
			error: error instanceof Error ? error.message : String(error),
		});
		return {};
	}
}

export function loadConfig(env: EnvSource = process.env as EnvSource): ReceiverConfig {
	const configPath = resolveReceiverConfigPath(env);
	const fileConfig = readReceiverFileConfig(configPath);

	const filePort = typeof fileConfig.port === "number" ? fileConfig.port : 7071;
	const fileBindAddress =
		typeof fileConfig.bindAddress === "string" ? fileConfig.bindAddress : "127.0.0.1";
	const fileToken = typeof fileConfig.token === "string" ? fileConfig.token : undefined;
	const fileDiscordBotToken =
		typeof fileConfig.discordBotToken === "string" ? fileConfig.discordBotToken : undefined;

	const parsed = ReceiverConfigSchema.safeParse({
		...fileConfig,
		port: parseIntWithDefault(env.AH_WEBHOOK_RECEIVER_PORT, filePort),
		bindAddress: env.AH_WEBHOOK_RECEIVER_BIND_ADDRESS?.trim() || fileBindAddress,
		token: env.AH_WEBHOOK_RECEIVER_TOKEN?.trim() || fileToken,
		discordBotToken: env.AH_WEBHOOK_RECEIVER_DISCORD_BOT_TOKEN?.trim() || fileDiscordBotToken,
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

export function formatHeaderMessage(payload: WebhookPayload): string {
	const base = `[${payload.event}] project=${payload.project} agent=${payload.agentId} provider=${payload.provider} status=${payload.status}`;
	const extraEntries = payload.extra ? Object.entries(payload.extra) : [];
	if (extraEntries.length === 0) return base;
	const extra = extraEntries
		.map(([key, value]) => `${key}=${value}`)
		.sort()
		.join(",");
	return `${base} extra=${extra}`;
}

function parseDiscordChannelId(discordChannel: string): string {
	const trimmed = discordChannel.trim();
	if (!trimmed) throw new Error("discordChannel is empty");
	if (/^\d+$/.test(trimmed)) return trimmed;
	throw new Error("discordChannel must be numeric id");
}

async function runDiscordAction(config: ReceiverConfig, payload: WebhookPayload): Promise<void> {
	const discordBotToken = config.discordBotToken?.trim();
	if (!discordBotToken) {
		throw new Error("discord bot token not configured");
	}

	const header = formatHeaderMessage(payload);
	const lastMessage = typeof payload.lastMessage === "string" ? payload.lastMessage.trim() : "";
	const inlineMessage =
		lastMessage.length > 0 && lastMessage.length < DISCORD_INLINE_CHAR_LIMIT
			? `${header}\n${lastMessage}`
			: header;
	const discordChannel = payload.discordChannel;
	if (!discordChannel) {
		throw new Error("discord channel not configured");
	}
	const channelId = parseDiscordChannelId(discordChannel);
	let response: Response;
	if (lastMessage.length >= DISCORD_INLINE_CHAR_LIMIT) {
		const form = new FormData();
		form.set(
			"payload_json",
			JSON.stringify({
				content: header,
				allowed_mentions: { parse: [] },
			}),
		);
		form.set("files[0]", new File([lastMessage], "message.txt", { type: "text/plain" }));
		response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
			method: "POST",
			headers: {
				Authorization: `Bot ${discordBotToken}`,
			},
			body: form,
			signal: AbortSignal.timeout(10000),
		});
	} else {
		response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bot ${discordBotToken}`,
			},
			body: JSON.stringify({
				content: inlineMessage,
				allowed_mentions: { parse: [] },
			}),
			signal: AbortSignal.timeout(10000),
		});
	}
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`discord api http ${response.status}: ${body.slice(0, 200)}`);
	}
}
export async function runActions(config: ReceiverConfig, payload: WebhookPayload): Promise<void> {
	if (payload.discordChannel) {
		try {
			await runDiscordAction(config, payload);
		} catch (error) {
			receiverLog("warn", "receiver discord action failed", {
				error: error instanceof Error ? error.message : String(error),
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

		receiverLog("info", "received webhook event", {
			event: parsed.data.event,
			project: parsed.data.project,
			agentId: parsed.data.agentId,
			status: parsed.data.status,
			hasDiscordChannel: Boolean(parsed.data.discordChannel),
			hasSessionKey: Boolean(parsed.data.sessionKey),
		});

		void runActions(config, parsed.data).catch((error) => {
			receiverLog("error", "receiver action pipeline failed", {
				error: error instanceof Error ? error.message : String(error),
				event: parsed.data.event,
				project: parsed.data.project,
				agentId: parsed.data.agentId,
			});
		});
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
		discordConfigured: Boolean(config.discordBotToken),
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
