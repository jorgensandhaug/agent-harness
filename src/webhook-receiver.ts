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
		openclawHooksUrl: z.string().url().optional(),
		openclawHooksToken: z.string().min(1).optional(),
		gatewayToken: z.string().min(1).optional(),
	})
	.strict();

type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;
export type ReceiverConfig = z.infer<typeof ReceiverConfigSchema>;
type ReceiverFileConfig = Partial<ReceiverConfig>;

type EnvSource = Readonly<{
	AH_WEBHOOK_RECEIVER_CONFIG?: string;
	AH_WEBHOOK_RECEIVER_PORT?: string;
	AH_WEBHOOK_RECEIVER_BIND_ADDRESS?: string;
	AH_WEBHOOK_RECEIVER_TOKEN?: string;
	AH_WEBHOOK_RECEIVER_HOOKS_URL?: string;
	AH_WEBHOOK_RECEIVER_HOOKS_TOKEN?: string;
	AH_WEBHOOK_RECEIVER_GATEWAY_TOKEN?: string;
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
	const fileHooksUrl =
		typeof fileConfig.openclawHooksUrl === "string" ? fileConfig.openclawHooksUrl : undefined;
	const fileHooksToken =
		typeof fileConfig.openclawHooksToken === "string" ? fileConfig.openclawHooksToken : undefined;
	const fileGatewayToken =
		typeof fileConfig.gatewayToken === "string" ? fileConfig.gatewayToken : undefined;

	const parsed = ReceiverConfigSchema.safeParse({
		...fileConfig,
		port: parseIntWithDefault(env.AH_WEBHOOK_RECEIVER_PORT, filePort),
		bindAddress: env.AH_WEBHOOK_RECEIVER_BIND_ADDRESS?.trim() || fileBindAddress,
		token: env.AH_WEBHOOK_RECEIVER_TOKEN?.trim() || fileToken,
		openclawHooksUrl: env.AH_WEBHOOK_RECEIVER_HOOKS_URL?.trim() || fileHooksUrl,
		openclawHooksToken: env.AH_WEBHOOK_RECEIVER_HOOKS_TOKEN?.trim() || fileHooksToken,
		gatewayToken: env.AH_WEBHOOK_RECEIVER_GATEWAY_TOKEN?.trim() || fileGatewayToken,
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

async function runDiscordAction(config: ReceiverConfig, payload: WebhookPayload): Promise<void> {
	const hooksUrl = config.openclawHooksUrl;
	if (!hooksUrl) {
		throw new Error("hooks/tools endpoint is not configured");
	}
	// Derive gateway base URL from hooks URL (e.g. http://host:port/hooks/agent -> http://host:port)
	const parsedHooksUrl = new URL(hooksUrl);
	const pathWithoutHooks = parsedHooksUrl.pathname.replace(/\/hooks\/.*$/, "");
	const baseUrl = `${parsedHooksUrl.origin}${pathWithoutHooks}`;
	const toolsUrl = `${baseUrl}/tools/invoke`;
	const message = formatEventMessage(payload);
	const headers = new Headers({ "Content-Type": "application/json" });
	if (config.gatewayToken) {
		headers.set("Authorization", `Bearer ${config.gatewayToken}`);
	}
	const response = await fetch(toolsUrl, {
		method: "POST",
		headers,
		body: JSON.stringify({
			tool: "message",
			args: {
				action: "send",
				channel: "discord",
				target: `channel:${payload.discordChannel}`,
				message,
			},
		}),
		signal: AbortSignal.timeout(10000),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`tools/invoke http ${response.status}: ${body.slice(0, 200)}`);
	}
}

async function runHooksAction(config: ReceiverConfig, payload: WebhookPayload): Promise<void> {
	const hooksUrl = config.openclawHooksUrl;
	if (!hooksUrl) {
		throw new Error("hooks endpoint is not configured");
	}
	const parsedHooksUrl = new URL(hooksUrl);
	const wakePath = parsedHooksUrl.pathname.replace(/\/[^/]*$/, "/wake");
	const wakeUrl = `${parsedHooksUrl.origin}${wakePath}${parsedHooksUrl.search}`;
	const wakePayload: WebhookPayload = { ...payload, sessionKey: null };
	const body = { text: formatEventMessage(wakePayload), mode: "now" as const };
	const headers = new Headers({ "Content-Type": "application/json" });
	if (config.openclawHooksToken) {
		headers.set("Authorization", `Bearer ${config.openclawHooksToken}`);
	}
	const response = await fetch(wakeUrl, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10000),
	});
	if (response.status !== 200) {
		throw new Error(`hooks endpoint http ${response.status}`);
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

	if (payload.sessionKey) {
		if (!config.openclawHooksUrl) {
			receiverLog(
				"warn",
				"session bump requested but AH_WEBHOOK_RECEIVER_HOOKS_URL not configured",
				{
					sessionKey: payload.sessionKey,
				},
			);
		} else {
			try {
				await runHooksAction(config, payload);
			} catch (error) {
				receiverLog("warn", "receiver hooks action failed", {
					error: error instanceof Error ? error.message : String(error),
					sessionKey: payload.sessionKey,
				});
			}
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
		hooksConfigured: Boolean(config.openclawHooksUrl),
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
