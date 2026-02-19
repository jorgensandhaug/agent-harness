import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ReceiverConfig,
	createReceiverApp,
	formatHeaderMessage,
	loadConfig,
	matchesBearerToken,
	runActions,
} from "./webhook-receiver.ts";

const originalFetch = globalThis.fetch;
const cleanupPaths: string[] = [];

afterEach(() => {
	(globalThis as { fetch: typeof fetch }).fetch = originalFetch;
});

afterEach(async () => {
	for (const path of cleanupPaths.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
});

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ah-webhook-config-test-"));
	cleanupPaths.push(dir);
	return dir;
}

function baseConfig(overrides: Partial<ReceiverConfig> = {}): ReceiverConfig {
	return {
		port: 7071,
		bindAddress: "127.0.0.1",
		token: undefined,
		discordBotToken: "test-discord-bot-token",
		...overrides,
	};
}

function basePayload() {
	return {
		event: "agent_completed" as const,
		project: "proj-1",
		agentId: "abcd1234",
		provider: "codex",
		status: "idle",
		lastMessage: "Done",
		timestamp: "2026-02-18T12:00:00.000Z",
	};
}

describe("webhook-receiver/loadConfig", () => {
	it("loads defaults with required discord bot token", () => {
		const config = loadConfig({
			AH_WEBHOOK_RECEIVER_DISCORD_BOT_TOKEN: "test-token",
		});
		expect(config.port).toBe(7071);
		expect(config.bindAddress).toBe("127.0.0.1");
		expect(config.discordBotToken).toBe("test-token");
	});

	it("accepts discord bot token from env var", () => {
		const config = loadConfig({
			AH_WEBHOOK_RECEIVER_DISCORD_BOT_TOKEN: "discord-bot-token-123",
		});
		expect(config.discordBotToken).toBe("discord-bot-token-123");
	});

	it("loads config from explicit AH_WEBHOOK_RECEIVER_CONFIG file", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "receiver.json");
		await writeFile(
			path,
			JSON.stringify({
				port: 7171,
				bindAddress: "0.0.0.0",
				discordBotToken: "file-token",
			}),
		);

		const config = loadConfig({
			AH_WEBHOOK_RECEIVER_CONFIG: path,
		});
		expect(config.port).toBe(7171);
		expect(config.bindAddress).toBe("0.0.0.0");
	});

	it("loads config from XDG default path", async () => {
		const xdgDir = await makeTempDir();
		const configDir = join(xdgDir, "agent-harness");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			join(configDir, "webhook-receiver.json"),
			JSON.stringify({
				port: 7272,
				discordBotToken: "xdg-token",
			}),
		);

		const config = loadConfig({
			XDG_CONFIG_HOME: xdgDir,
		});
		expect(config.port).toBe(7272);
	});

	it("applies env overrides on top of file config", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "receiver.json");
		await writeFile(
			path,
			JSON.stringify({
				port: 7373,
				discordBotToken: "from-file-discord-token",
			}),
		);

		const config = loadConfig({
			AH_WEBHOOK_RECEIVER_CONFIG: path,
			AH_WEBHOOK_RECEIVER_PORT: "7474",
			AH_WEBHOOK_RECEIVER_DISCORD_BOT_TOKEN: "from-env-discord-token",
		});
		expect(config.port).toBe(7474);
		expect(config.discordBotToken).toBe("from-env-discord-token");
	});
});

describe("webhook-receiver/auth", () => {
	it("matches bearer token exactly", () => {
		expect(matchesBearerToken(undefined, "x")).toBe(false);
		expect(matchesBearerToken("Bearer x", "x")).toBe(true);
		expect(matchesBearerToken("Bearer y", "x")).toBe(false);
		expect(matchesBearerToken("Basic x", "x")).toBe(false);
	});
});

describe("webhook-receiver/actions", () => {
	it("posts directly to discord api when discord bot token is configured", async () => {
		const calls: Array<{ url: string; body: unknown; authHeader: string | null }> = [];
		(globalThis as { fetch: typeof fetch }).fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			const body = await request.json();
			calls.push({
				url: request.url,
				body,
				authHeader: request.headers.get("authorization"),
			});
			return new Response(JSON.stringify({ id: "123" }), { status: 200 });
		}) as typeof fetch;

		await runActions(
			baseConfig({
				discordBotToken: "discord-bot-token-456",
			}),
			{
				...basePayload(),
				discordChannel: "1473266182177165354",
			},
		);

		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/1473266182177165354/messages");
		expect(calls[0]?.authHeader).toBe("Bot discord-bot-token-456");
		const body = calls[0]?.body as {
			content: string;
			allowed_mentions: { parse: string[] };
		};
		expect(body.content).toContain("[agent_completed]");
		expect(body.content).toContain("project=proj-1");
		expect(body.content).toContain("agent=abcd1234");
		expect(body.content).toContain("provider=codex");
		expect(body.content).toContain("status=idle");
		expect(body.content).toContain("\nDone");
		expect(body.content).not.toContain("discordChannel=");
		expect(body.allowed_mentions.parse).toEqual([]);
	});

	it("uploads lastMessage as message.txt when direct discord message is long", async () => {
		const calls: Array<{
			url: string;
			authHeader: string | null;
			contentType: string | null;
			payloadJson: string | null;
			fileName: string | null;
			fileText: string | null;
		}> = [];
		(globalThis as { fetch: typeof fetch }).fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			const form = await request.formData();
			const fileEntry = form.get("files[0]");
			calls.push({
				url: request.url,
				authHeader: request.headers.get("authorization"),
				contentType: request.headers.get("content-type"),
				payloadJson:
					typeof form.get("payload_json") === "string"
						? (form.get("payload_json") as string)
						: null,
				fileName: fileEntry instanceof File ? fileEntry.name : null,
				fileText: fileEntry instanceof File ? await fileEntry.text() : null,
			});
			return new Response(JSON.stringify({ id: "456" }), { status: 200 });
		}) as typeof fetch;

		const longLastMessage = "x".repeat(250);
		await runActions(
			baseConfig({
				discordBotToken: "discord-bot-token-789",
			}),
			{
				...basePayload(),
				lastMessage: longLastMessage,
				discordChannel: "1473266182177165354",
			},
		);

		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe("https://discord.com/api/v10/channels/1473266182177165354/messages");
		expect(calls[0]?.authHeader).toBe("Bot discord-bot-token-789");
		expect(calls[0]?.contentType).toContain("multipart/form-data");
		expect(calls[0]?.fileName).toBe("message.txt");
		expect(calls[0]?.fileText).toBe(longLastMessage);

		const payloadJson = calls[0]?.payloadJson;
		expect(payloadJson).not.toBeNull();
		const parsedPayloadJson = JSON.parse(payloadJson ?? "{}") as {
			content?: string;
			allowed_mentions?: { parse?: string[] };
		};
		expect(parsedPayloadJson.content).toContain("[agent_completed]");
		expect(parsedPayloadJson.content).toContain("project=proj-1");
		expect(parsedPayloadJson.content).not.toContain(longLastMessage);
		expect(parsedPayloadJson.allowed_mentions?.parse).toEqual([]);
	});
});

describe("webhook-receiver/http", () => {
	it("enforces bearer token on webhook endpoint", async () => {
		const app = createReceiverApp(baseConfig({ token: "secret" }));

		const noToken = await app.fetch(
			new Request("http://localhost/harness-webhook", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(basePayload()),
			}),
		);
		expect(noToken.status).toBe(401);

		const withToken = await app.fetch(
			new Request("http://localhost/harness-webhook", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer secret",
				},
				body: JSON.stringify(basePayload()),
			}),
		);
		expect(withToken.status).toBe(200);
	});

	it("acks webhook immediately even when downstream action is slow", async () => {
		let resolveFetch: ((value: Response) => void) | null = null;
		(globalThis as { fetch: typeof fetch }).fetch = (() => {
			return new Promise<Response>((resolve) => {
				resolveFetch = resolve;
			});
		}) as typeof fetch;

		const app = createReceiverApp(
			baseConfig({
				discordBotToken: "discord-bot-token-slow",
			}),
		);

		const responsePromise = app.fetch(
			new Request("http://localhost/harness-webhook", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...basePayload(),
					discordChannel: "1473266182177165354",
				}),
			}),
		);

		const response = await Promise.race([
			responsePromise,
			new Promise<Response>((_, reject) =>
				setTimeout(() => reject(new Error("webhook response timed out")), 100),
			),
		]);
		expect(response.status).toBe(200);

		resolveFetch?.(new Response(JSON.stringify({ ok: true }), { status: 200 }));
		await responsePromise;
	});
});

describe("webhook-receiver/format", () => {
	it("formats header message without routing fields and with extra metadata", () => {
		const header = formatHeaderMessage({
			...basePayload(),
			discordChannel: "alerts",
			sessionKey: "ops-room",
			extra: {
				requestId: "req-1",
				retry: "2",
			},
		});
		expect(header).toContain("[agent_completed]");
		expect(header).toContain("project=proj-1");
		expect(header).toContain("agent=abcd1234");
		expect(header).toContain("provider=codex");
		expect(header).toContain("status=idle");
		expect(header).toContain("extra=requestId=req-1,retry=2");
		expect(header).not.toContain("discordChannel=");
		expect(header).not.toContain("sessionKey=");
		expect(header.includes("\n")).toBe(false);
	});

	it("formats header message without extra metadata", () => {
		const header = formatHeaderMessage(basePayload());
		expect(header).toContain("[agent_completed]");
		expect(header).not.toContain("extra=");
	});
});
