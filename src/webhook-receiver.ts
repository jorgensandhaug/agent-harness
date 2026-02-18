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
	})
	.strict();

const ReceiverActionSchema = z.enum(["stdout_log"]);

const ReceiverConfigSchema = z
	.object({
		port: z.number().int().min(1).max(65535),
		token: z.string().min(1).optional(),
		actions: z.array(ReceiverActionSchema).min(1),
	})
	.strict();

type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;
type ReceiverAction = z.infer<typeof ReceiverActionSchema>;
type ReceiverConfig = z.infer<typeof ReceiverConfigSchema>;

function parseActions(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const actions = value
		.split(",")
		.map((action) => action.trim())
		.filter((action) => action.length > 0);
	return actions.length > 0 ? actions : undefined;
}

function loadConfig(): ReceiverConfig {
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const rawPort = process.env["AH_WEBHOOK_RECEIVER_PORT"];
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const rawToken = process.env["AH_WEBHOOK_RECEIVER_TOKEN"]?.trim();
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const rawActions = process.env["AH_WEBHOOK_RECEIVER_ACTIONS"];
	const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : 7071;
	const parsed = ReceiverConfigSchema.safeParse({
		port: parsedPort,
		token: rawToken && rawToken.length > 0 ? rawToken : undefined,
		actions: parseActions(rawActions) ?? ["stdout_log"],
	});

	if (parsed.success) return parsed.data;
	const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
	throw new Error(`Invalid webhook receiver config: ${issues.join("; ")}`);
}

function matchesBearerToken(authHeader: string | undefined, expectedToken: string): boolean {
	if (!authHeader) return false;
	const prefix = "Bearer ";
	if (!authHeader.startsWith(prefix)) return false;
	const token = authHeader.slice(prefix.length);
	return token === expectedToken;
}

function runAction(action: ReceiverAction, payload: WebhookPayload): void {
	if (action === "stdout_log") {
		console.log(
			JSON.stringify({
				type: "agent_harness_webhook",
				receivedAt: new Date().toISOString(),
				payload,
			}),
		);
	}
}

function runActions(actions: readonly ReceiverAction[], payload: WebhookPayload): void {
	for (const action of actions) {
		runAction(action, payload);
	}
}

const config = loadConfig();
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

	runActions(config.actions, parsed.data);
	return c.json({ ok: true });
});

const server = Bun.serve({
	port: config.port,
	fetch: app.fetch,
	idleTimeout: 120,
});

console.log(
	JSON.stringify({
		msg: "webhook receiver started",
		port: server.port,
		actions: config.actions,
		tokenRequired: Boolean(config.token),
	}),
);

const shutdown = () => {
	server.stop(true);
	process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
