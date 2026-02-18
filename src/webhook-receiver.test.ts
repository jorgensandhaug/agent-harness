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
		openclawCommand: "openclaw",
		openclawTimeoutMs: 5000,
		openclawHooksUrl: undefined,
		openclawHooksToken: undefined,
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
		expect(config.openclawHooksUrl).toBeUndefined();
		expect(config.openclawHooksToken).toBeUndefined();
	});

	it("accepts hooks config from env vars", () => {
		const config = loadConfig({
			AH_WEBHOOK_RECEIVER_HOOKS_URL: "http://127.0.0.1:18789/hooks/agent",
			AH_WEBHOOK_RECEIVER_HOOKS_TOKEN: "tok-123",
		});
		expect(config.openclawHooksUrl).toBe("http://127.0.0.1:18789/hooks/agent");
		expect(config.openclawHooksToken).toBe("tok-123");
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
	it("spawns openclaw message send when payload has discordChannel", async () => {
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
			discordChannel: "alerts",
		});

		expect(seen).not.toBeNull();
		expect(seen?.[0]).toBe("openclaw");
		expect(seen?.[1]).toBe("message");
		expect(seen?.[2]).toBe("send");
		expect(seen?.[3]).toBe("--channel");
		expect(seen?.[4]).toBe("discord");
		expect(seen?.[5]).toBe("--target");
		expect(seen?.[6]).toBe("channel:alerts");
		expect(seen?.[7]).toBe("--message");
		expect(seen?.[8] ?? "").toContain("discordChannel=alerts");
	});

	it("posts to hooks endpoint when payload has sessionKey", async () => {
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
			return new Response(null, { status: 202 });
		}) as typeof fetch;

		await runActions(
			baseConfig({
				openclawHooksUrl: "http://127.0.0.1:18789/hooks/agent",
				openclawHooksToken: "tok-123",
			}),
			{
				...basePayload(),
				sessionKey: "main-session",
			},
		);

		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:18789/hooks/agent");
		expect(calls[0]?.authHeader).toBe("Bearer tok-123");
		const body = calls[0]?.body as { message: string; sessionKey: string };
		expect(body.sessionKey).toBe("main-session");
		expect(body.message).toContain("sessionKey=main-session");
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
