import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

const cleanupPaths: string[] = [];
const originalAuthToken = process.env.AH_AUTH_TOKEN;
const originalWebhookToken = process.env.AH_WEBHOOK_TOKEN;

afterEach(async () => {
	for (const path of cleanupPaths.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
	if (originalAuthToken === undefined) {
		process.env.AH_AUTH_TOKEN = undefined;
	} else {
		process.env.AH_AUTH_TOKEN = originalAuthToken;
	}
	if (originalWebhookToken === undefined) {
		process.env.AH_WEBHOOK_TOKEN = undefined;
	} else {
		process.env.AH_WEBHOOK_TOKEN = originalWebhookToken;
	}
});

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ah-config-test-"));
	cleanupPaths.push(dir);
	return dir;
}

describe("config/load.defaults", () => {
	it("returns defaults when config file does not exist", async () => {
		const dir = await makeTempDir();
		const config = await loadConfig(join(dir, "missing.json"));

		expect(config.port).toBe(7070);
		expect(config.bindAddress).toBe("127.0.0.1");
		expect(config.tmuxPrefix).toBe("ah");
		expect(config.pollIntervalMs).toBe(1000);
		expect(Object.keys(config.providers).sort()).toEqual([
			"claude-code",
			"codex",
			"opencode",
			"pi",
		]);
		expect(config.providers["claude-code"]?.extraArgs).toEqual([
			"--dangerously-skip-permissions",
			"--permission-mode",
			"bypassPermissions",
		]);
		expect(config.providers.codex?.extraArgs).toEqual(["--yolo"]);
		expect(config.subscriptions).toEqual({});
	});
});

describe("config/load.valid-file", () => {
	it("parses valid file and applies schema defaults", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(
			path,
			JSON.stringify({
				port: 5050,
				pollIntervalMs: 200,
				providers: {
					codex: {
						command: "codex",
						model: "nano",
					},
				},
			}),
		);

		const config = await loadConfig(path);
		expect(config.port).toBe(5050);
		expect(config.pollIntervalMs).toBe(200);
		expect(config.providers.codex).toEqual({
			command: "codex",
			extraArgs: [],
			env: {},
			model: "nano",
			enabled: true,
		});
	});

	it("parses subscription profiles", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(
			path,
			JSON.stringify({
				subscriptions: {
					"claude-max": {
						provider: "claude-code",
						sourceDir: "/tmp/claude-max",
					},
					"codex-plus": {
						provider: "codex",
						mode: "chatgpt",
						sourceDir: "/tmp/codex-plus",
						workspaceId: "acct-123",
						enforceWorkspace: true,
					},
				},
			}),
		);

		const config = await loadConfig(path);
		expect(config.subscriptions["claude-max"]?.provider).toBe("claude-code");
		expect(config.subscriptions["claude-max"]?.mode).toBe("oauth");
		expect(config.subscriptions["codex-plus"]?.provider).toBe("codex");
		expect(config.subscriptions["codex-plus"]?.mode).toBe("chatgpt");
	});

	it("applies webhook safety-net defaults", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(
			path,
			JSON.stringify({
				webhook: {
					url: "https://example.test/hook",
					events: ["agent_completed"],
				},
			}),
		);

		const config = await loadConfig(path);
		expect(config.webhook?.safetyNet).toEqual({
			enabled: false,
			intervalMs: 30000,
			stuckAfterMs: 180000,
			stuckWarnIntervalMs: 300000,
		});
	});

	it("parses webhook safety-net config override", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(
			path,
			JSON.stringify({
				webhook: {
					url: "https://example.test/hook",
					events: ["agent_error"],
					safetyNet: {
						enabled: true,
						intervalMs: 5000,
						stuckAfterMs: 45000,
						stuckWarnIntervalMs: 60000,
					},
				},
			}),
		);

		const config = await loadConfig(path);
		expect(config.webhook?.safetyNet).toEqual({
			enabled: true,
			intervalMs: 5000,
			stuckAfterMs: 45000,
			stuckWarnIntervalMs: 60000,
		});
	});
});

describe("config/load.auth", () => {
	it("parses auth token from config file", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(
			path,
			JSON.stringify({
				auth: { token: "from-file-token" },
			}),
		);

		const config = await loadConfig(path);
		expect(config.auth?.token).toBe("from-file-token");
	});

	it("overrides auth token from AH_AUTH_TOKEN env", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(
			path,
			JSON.stringify({
				auth: { token: "from-file-token" },
			}),
		);
		process.env.AH_AUTH_TOKEN = "from-env-token";

		const config = await loadConfig(path);
		expect(config.auth?.token).toBe("from-env-token");
	});

	it("overrides webhook token from AH_WEBHOOK_TOKEN env", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(
			path,
			JSON.stringify({
				webhook: {
					url: "https://example.test/hook",
					token: "from-file-webhook-token",
					events: ["agent_completed"],
				},
			}),
		);
		process.env.AH_WEBHOOK_TOKEN = "from-env-webhook-token";

		const config = await loadConfig(path);
		expect(config.webhook?.token).toBe("from-env-webhook-token");
	});
});

describe("config/load.invalid-file", () => {
	it("throws strict, field-specific validation error", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(path, JSON.stringify({ port: "bad" }));

		await expect(loadConfig(path)).rejects.toThrow(/Invalid config: port:/);
	});

	it("rejects codex subscription with enforceWorkspace but no workspaceId", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(
			path,
			JSON.stringify({
				subscriptions: {
					bad: {
						provider: "codex",
						mode: "chatgpt",
						sourceDir: "/tmp/codex",
						enforceWorkspace: true,
					},
				},
			}),
		);

		await expect(loadConfig(path)).rejects.toThrow(
			/workspaceId is required when enforceWorkspace=true/,
		);
	});
});
