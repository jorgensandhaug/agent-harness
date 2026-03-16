import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

const cleanupPaths: string[] = [];
const originalAuthToken = process.env.AH_AUTH_TOKEN;
const originalWebhookToken = process.env.AH_WEBHOOK_TOKEN;
const originalHarnessConfig = process.env.HARNESS_CONFIG;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

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
	if (originalHarnessConfig === undefined) {
		process.env.HARNESS_CONFIG = undefined;
	} else {
		process.env.HARNESS_CONFIG = originalHarnessConfig;
	}
	if (originalXdgConfigHome === undefined) {
		process.env.XDG_CONFIG_HOME = undefined;
	} else {
		process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
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
		expect(config.subscriptionDiscovery).toEqual({
			enabled: true,
			includeDefaults: true,
			sources: {},
			profiles: [],
			claudeDirs: [],
			claudeTokenFiles: [],
			codexDirs: [],
		});
	});

	it("loads default config from XDG path", async () => {
		const xdgDir = await makeTempDir();
		const configDir = join(xdgDir, "agent-harness");
		const path = join(configDir, "harness.json");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			path,
			JSON.stringify({
				port: 6060,
			}),
		);

		process.env.HARNESS_CONFIG = undefined;
		process.env.XDG_CONFIG_HOME = xdgDir;
		const config = await loadConfig();

		expect(config.port).toBe(6060);
	});

	it("prefers HARNESS_CONFIG over XDG default path", async () => {
		const dir = await makeTempDir();
		const envPath = join(dir, "env-harness.json");
		await writeFile(envPath, JSON.stringify({ port: 6161 }));

		const xdgDir = await makeTempDir();
		const xdgConfigDir = join(xdgDir, "agent-harness");
		await mkdir(xdgConfigDir, { recursive: true });
		await writeFile(join(xdgConfigDir, "harness.json"), JSON.stringify({ port: 6262 }));

		process.env.HARNESS_CONFIG = envPath;
		process.env.XDG_CONFIG_HOME = xdgDir;
		const config = await loadConfig();

		expect(config.port).toBe(6161);
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

	it("parses claude tokenFile subscription profile", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(
			path,
			JSON.stringify({
				subscriptions: {
					"claude-cloudgeni": {
						provider: "claude-code",
						mode: "oauth",
						tokenFile: "/tmp/claude-tokens/cloudgeni.token",
					},
				},
			}),
		);

		const config = await loadConfig(path);
		expect(config.subscriptions["claude-cloudgeni"]?.provider).toBe("claude-code");
		expect(config.subscriptions["claude-cloudgeni"]?.tokenFile).toBe(
			"/tmp/claude-tokens/cloudgeni.token",
		);
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

	it("parses subscription discovery config override", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(
			path,
			JSON.stringify({
				subscriptionDiscovery: {
					enabled: false,
					includeDefaults: false,
					sources: {
						claude_token: {
							kind: "env",
							name: "CLOUDGENI_CLAUDE_TOKEN",
						},
					},
					profiles: [
						{
							provider: "claude-code",
							source: "claude_token",
							valueType: "token",
							label: "cloudgeni",
						},
					],
					claudeDirs: ["/tmp/claude-work"],
					claudeTokenFiles: ["/tmp/claude-tokens/default.token"],
					codexDirs: ["/tmp/codex-team"],
				},
			}),
		);

		const config = await loadConfig(path);
		expect(config.subscriptionDiscovery).toEqual({
			enabled: false,
			includeDefaults: false,
			sources: {
				claude_token: {
					kind: "env",
					name: "CLOUDGENI_CLAUDE_TOKEN",
				},
			},
			profiles: [
				{
					provider: "claude-code",
					source: "claude_token",
					valueType: "token",
					label: "cloudgeni",
					enabled: true,
				},
			],
			claudeDirs: ["/tmp/claude-work"],
			claudeTokenFiles: ["/tmp/claude-tokens/default.token"],
			codexDirs: ["/tmp/codex-team"],
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

	it("rejects claude subscription without sourceDir or tokenFile", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(
			path,
			JSON.stringify({
				subscriptions: {
					bad: {
						provider: "claude-code",
						mode: "oauth",
					},
				},
			}),
		);

		await expect(loadConfig(path)).rejects.toThrow(
			/either sourceDir or tokenFile is required for claude oauth subscription/,
		);
	});
});
