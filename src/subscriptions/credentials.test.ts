import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubscriptionConfig } from "../config.ts";
import { summarizeSubscription } from "./credentials.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
	for (const dir of cleanupDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

describe("subscriptions/credentials.summarizeSubscription", () => {
	it("validates claude credentials with user:inference scope", async () => {
		const dir = await makeTempDir("ah-sub-claude-");
		await Bun.write(
			join(dir, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: "sk-ant-oat01-test",
					scopes: ["user:inference"],
					subscriptionType: "max",
					rateLimitTier: "default_claude_max_5x",
				},
			}),
		);
		const sub: SubscriptionConfig = {
			provider: "claude-code",
			mode: "oauth",
			sourceDir: dir,
			expected: { subscriptionType: "max" },
		};

		const summary = await summarizeSubscription("claude-a", sub);
		expect(summary.valid).toBe(true);
		expect(summary.reason).toBeNull();
		expect(summary.metadata.subscriptionType).toBe("max");
	});

	it("rejects claude credentials missing user:inference scope", async () => {
		const dir = await makeTempDir("ah-sub-claude-");
		await Bun.write(
			join(dir, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: "sk-ant-oat01-test",
					scopes: ["user:profile"],
				},
			}),
		);
		const sub: SubscriptionConfig = {
			provider: "claude-code",
			mode: "oauth",
			sourceDir: dir,
		};

		const summary = await summarizeSubscription("claude-b", sub);
		expect(summary.valid).toBe(false);
		expect(summary.reason).toContain("user:inference");
	});

	it("validates claude tokenFile subscriptions", async () => {
		const dir = await makeTempDir("ah-sub-claude-token-");
		const tokenFile = join(dir, "cloudgeni.token");
		await Bun.write(tokenFile, "sk-ant-oat01-cloudgeni\n");
		const sub: SubscriptionConfig = {
			provider: "claude-code",
			mode: "oauth",
			tokenFile,
		};

		const summary = await summarizeSubscription("claude-token-a", sub);
		expect(summary.valid).toBe(true);
		expect(summary.metadata.tokenLength).toBeGreaterThan(0);
	});

	it("rejects claude tokenFile subscriptions when token file is empty", async () => {
		const dir = await makeTempDir("ah-sub-claude-token-");
		const tokenFile = join(dir, "empty.token");
		await Bun.write(tokenFile, "   \n");
		const sub: SubscriptionConfig = {
			provider: "claude-code",
			mode: "oauth",
			tokenFile,
		};

		const summary = await summarizeSubscription("claude-token-b", sub);
		expect(summary.valid).toBe(false);
		expect(summary.reason).toContain("tokenFile");
	});

	it("validates codex chatgpt auth and extracts metadata", async () => {
		const dir = await makeTempDir("ah-sub-codex-");
		const payload = Buffer.from(
			JSON.stringify({
				email: "a@example.com",
				"https://api.openai.com/auth": {
					chatgpt_plan_type: "plus",
					organizations: [{ id: "org-1", title: "Personal", role: "owner", is_default: true }],
				},
			}),
		)
			.toString("base64url")
			.replace(/=/g, "");
		const fakeJwt = `x.${payload}.y`;
		await Bun.write(
			join(dir, "auth.json"),
			JSON.stringify({
				OPENAI_API_KEY: null,
				last_refresh: "2026-02-18T00:00:00.000Z",
				tokens: {
					id_token: fakeJwt,
					access_token: fakeJwt,
					refresh_token: "rt_abc",
					account_id: "acct-123",
				},
			}),
		);
		const sub: SubscriptionConfig = {
			provider: "codex",
			mode: "chatgpt",
			sourceDir: dir,
			workspaceId: "acct-123",
			enforceWorkspace: true,
		};

		const summary = await summarizeSubscription("codex-a", sub);
		expect(summary.valid).toBe(true);
		expect(summary.metadata.plan).toBe("plus");
		expect(summary.metadata.accountId).toBe("acct-123");
	});

	it("rejects codex apikey mode without OPENAI_API_KEY", async () => {
		const dir = await makeTempDir("ah-sub-codex-");
		await Bun.write(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null }));
		const sub: SubscriptionConfig = {
			provider: "codex",
			mode: "apikey",
			sourceDir: dir,
		};

		const summary = await summarizeSubscription("codex-b", sub);
		expect(summary.valid).toBe(false);
		expect(summary.reason).toContain("OPENAI_API_KEY");
	});
});
