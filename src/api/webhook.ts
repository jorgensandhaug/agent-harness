import type { Hono } from "hono";
import type { WebhookClient } from "../webhook/client.ts";

type ProbeResult = {
	url: string;
	ok: boolean;
	status: number | null;
	bodySnippet: string | null;
	error: string | null;
};

function summarizeBody(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed.length === 0) return null;
	return trimmed.slice(0, 400);
}

async function probeUrl(url: string, init?: RequestInit, timeoutMs = 5000): Promise<ProbeResult> {
	try {
		const response = await fetch(url, {
			...init,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		return {
			url,
			ok: response.ok,
			status: response.status,
			bodySnippet: summarizeBody(text),
			error: null,
		};
	} catch (error) {
		return {
			url,
			ok: false,
			status: null,
			bodySnippet: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function deriveReceiverBaseUrl(webhookUrl: string): string | null {
	try {
		const parsed = new URL(webhookUrl);
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return null;
	}
}

export function registerWebhookRoutes(app: Hono, webhookClient: WebhookClient | null): void {
	app.get("/api/v1/webhook/status", (c) => {
		if (!webhookClient) {
			return c.json({
				configured: false,
				reason: "webhook not configured",
			});
		}
		return c.json({
			configured: true,
			status: webhookClient.getStatus(),
		});
	});

	app.post("/api/v1/webhook/test", async (c) => {
		if (!webhookClient) {
			return c.json(
				{
					error: "WEBHOOK_NOT_CONFIGURED",
					message: "webhook is not configured",
				},
				400,
			);
		}

		let body: Record<string, unknown> = {};
		try {
			if (c.req.header("content-type")?.includes("application/json")) {
				const parsed = await c.req.json();
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					body = parsed as Record<string, unknown>;
				}
			}
		} catch {
			body = {};
		}

		const input: Parameters<WebhookClient["sendTestWebhook"]>[0] = {};
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const eventRaw = body["event"];
		if (
			typeof eventRaw === "string" &&
			(eventRaw === "agent_completed" || eventRaw === "agent_error" || eventRaw === "agent_exited")
		) {
			input.event = eventRaw;
		}
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const projectRaw = body["project"];
		if (typeof projectRaw === "string") {
			input.project = projectRaw;
		}
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const agentIdRaw = body["agentId"];
		if (typeof agentIdRaw === "string") {
			input.agentId = agentIdRaw;
		}
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const providerRaw = body["provider"];
		if (typeof providerRaw === "string") {
			input.provider = providerRaw;
		}
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const statusRaw = body["status"];
		if (typeof statusRaw === "string") {
			input.status = statusRaw;
		}
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const lastMessageRaw = body["lastMessage"];
		if (typeof lastMessageRaw === "string" || lastMessageRaw === null) {
			input.lastMessage = lastMessageRaw;
		}
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const urlRaw = body["url"];
		if (typeof urlRaw === "string") {
			input.url = urlRaw;
		}
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const tokenRaw = body["token"];
		if (typeof tokenRaw === "string") {
			input.token = tokenRaw;
		}
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const discordChannelRaw = body["discordChannel"];
		if (typeof discordChannelRaw === "string") {
			input.discordChannel = discordChannelRaw;
		}
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const sessionKeyRaw = body["sessionKey"];
		if (typeof sessionKeyRaw === "string") {
			input.sessionKey = sessionKeyRaw;
		}
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const extraRaw = body["extra"];
		if (extraRaw && typeof extraRaw === "object" && !Array.isArray(extraRaw)) {
			const entries = Object.entries(extraRaw);
			const parsedExtra: Record<string, string> = {};
			for (const [key, value] of entries) {
				if (typeof value === "string") {
					parsedExtra[key] = value;
				}
			}
			if (Object.keys(parsedExtra).length > 0) {
				input.extra = parsedExtra;
			}
		}

		const result = await webhookClient.sendTestWebhook(input);

		return c.json({
			ok: result.ok,
			result,
			status: webhookClient.getStatus(),
		});
	});

	app.post("/api/v1/webhook/probe-receiver", async (c) => {
		if (!webhookClient) {
			return c.json(
				{
					error: "WEBHOOK_NOT_CONFIGURED",
					message: "webhook is not configured",
				},
				400,
			);
		}

		let body: Record<string, unknown> = {};
		try {
			if (c.req.header("content-type")?.includes("application/json")) {
				const parsed = await c.req.json();
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					body = parsed as Record<string, unknown>;
				}
			}
		} catch {
			body = {};
		}

		const status = webhookClient.getStatus();
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const baseUrlRaw = body["baseUrl"];
		const bodyBaseUrl =
			typeof baseUrlRaw === "string" && baseUrlRaw.trim().length > 0 ? baseUrlRaw.trim() : null;
		const baseUrl = bodyBaseUrl ?? deriveReceiverBaseUrl(status.config.url);
		if (!baseUrl) {
			return c.json(
				{
					error: "INVALID_WEBHOOK_URL",
					message: "could not derive receiver base url",
					webhookUrl: status.config.url,
				},
				400,
			);
		}

		const normalizedBase = baseUrl.replace(/\/+$/, "");
		const health = await probeUrl(`${normalizedBase}/health`, { method: "GET" });
		const harnessWebhook = await probeUrl(
			`${normalizedBase}/harness-webhook`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			},
			6000,
		);

		return c.json({
			baseUrl: normalizedBase,
			health,
			harnessWebhook,
		});
	});
}
