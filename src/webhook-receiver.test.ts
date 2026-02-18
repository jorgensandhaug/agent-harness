import { afterEach, describe, expect, it } from "bun:test";
import {
	type ReceiverConfig,
	createReceiverApp,
	formatEventMessage,
	loadConfig,
	matchesBearerToken,
	runActions,
} from "./webhook-receiver.ts";

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;

afterEach(() => {
	(globalThis as { fetch: typeof fetch }).fetch = originalFetch;
	(Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
});

function baseConfig(overrides: Partial<ReceiverConfig> = {}): ReceiverConfig {
	return {
		port: 7071,
		bindAddress: "127.0.0.1",
		token: undefined,
		discordWebhookUrl: undefined,
		openclawCommand: "openclaw",
		openclawArgs: ["system", "event"],
		openclawTimeoutMs: 5000,
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
	it("loads defaults", () => {
		const config = loadConfig({});
		expect(config.port).toBe(7071);
		expect(config.bindAddress).toBe("127.0.0.1");
		expect(config.openclawCommand).toBe("openclaw");
		expect(config.openclawArgs).toEqual(["system", "event"]);
		expect(config.discordWebhookUrl).toBeUndefined();
	});

	it("accepts discord webhook from AH_DISCORD_WEBHOOK_URL", () => {
		const config = loadConfig({
			AH_DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
		});
		expect(config.discordWebhookUrl).toBe("https://discord.example/webhook");
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
	it("posts to discord when payload requests discordChannel", async () => {
		const calls: Array<{ url: string; content: string }> = [];
		(globalThis as { fetch: typeof fetch }).fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			const body = (await request.json()) as { content?: string };
			calls.push({
				url: request.url,
				content: String(body.content ?? ""),
			});
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		await runActions(
			baseConfig({
				discordWebhookUrl: "https://discord.example/webhook",
			}),
			{
				...basePayload(),
				discordChannel: "alerts",
			},
		);

		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe("https://discord.example/webhook");
		expect(calls[0]?.content).toContain("discordChannel=alerts");
	});

	it("runs openclaw command when payload has sessionKey", async () => {
		let seen: string[] | null = null;
		(Bun as { spawn: typeof Bun.spawn }).spawn = ((cmd: readonly string[]) => {
			seen = [...cmd];
			return {
				exited: Promise.resolve(0),
				stdout: new Blob([""]).stream(),
				stderr: new Blob([""]).stream(),
				kill: () => {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		await runActions(baseConfig(), {
			...basePayload(),
			sessionKey: "main-session",
		});

		expect(seen).not.toBeNull();
		expect(seen?.[0]).toBe("openclaw");
		expect(seen?.[1]).toBe("system");
		expect(seen?.[2]).toBe("event");
		expect(seen?.[seen.length - 1] ?? "").toContain("sessionKey=main-session");
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
});

describe("webhook-receiver/format", () => {
	it("formats event message with routing fields and extra metadata", () => {
		const withText = formatEventMessage({
			...basePayload(),
			discordChannel: "alerts",
			sessionKey: "ops-room",
			extra: {
				requestId: "req-1",
			},
		});
		expect(withText).toContain("[agent_completed]");
		expect(withText).toContain("discordChannel=alerts");
		expect(withText).toContain("sessionKey=ops-room");
		expect(withText).toContain("extra=requestId=req-1");
		expect(withText).toContain("\nDone");

		const withoutText = formatEventMessage({ ...basePayload(), lastMessage: null });
		expect(withoutText.includes("\n")).toBe(false);
	});
});
