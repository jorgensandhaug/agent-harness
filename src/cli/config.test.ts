import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliConfig } from "./config.ts";

const cleanupPaths: string[] = [];

const originalEnv = {
	AH_CONFIG: process.env.AH_CONFIG,
	AH_URL: process.env.AH_URL,
	AH_TOKEN: process.env.AH_TOKEN,
	AH_JSON: process.env.AH_JSON,
	AH_COMPACT: process.env.AH_COMPACT,
	AH_CALLBACK_URL: process.env.AH_CALLBACK_URL,
	AH_CALLBACK_TOKEN: process.env.AH_CALLBACK_TOKEN,
	AH_DISCORD_CHANNEL: process.env.AH_DISCORD_CHANNEL,
	AH_SESSION_KEY: process.env.AH_SESSION_KEY,
};

function restoreEnvVar(key: keyof typeof originalEnv): void {
	const value = originalEnv[key];
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}

async function writeConfigFile(config: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ah-cli-config-test-"));
	cleanupPaths.push(dir);
	const path = join(dir, "cli.json");
	await writeFile(path, JSON.stringify(config));
	return path;
}

afterEach(async () => {
	for (const path of cleanupPaths.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}

	for (const key of Object.keys(originalEnv) as Array<keyof typeof originalEnv>) {
		restoreEnvVar(key);
	}
});

describe("cli/config.resolveCliConfig.callbacks", () => {
	it("loads callback defaults from cli.json", async () => {
		const configPath = await writeConfigFile({
			callbackUrl: "https://hooks.example.test/agent",
			callbackToken: "callback-token",
			discordChannel: "ops-alerts",
			sessionKey: "session-key-1",
		});
		process.env.AH_CONFIG = configPath;

		const config = await resolveCliConfig({});
		expect(config.callbackUrl).toBe("https://hooks.example.test/agent");
		expect(config.callbackToken).toBe("callback-token");
		expect(config.discordChannel).toBe("ops-alerts");
		expect(config.sessionKey).toBe("session-key-1");
	});

	it("prefers callback env vars over cli.json", async () => {
		const configPath = await writeConfigFile({
			callbackUrl: "https://hooks.example.test/from-file",
			callbackToken: "file-token",
			discordChannel: "from-file",
			sessionKey: "file-session",
		});
		process.env.AH_CONFIG = configPath;
		process.env.AH_CALLBACK_URL = "https://hooks.example.test/from-env";
		process.env.AH_CALLBACK_TOKEN = "env-token";
		process.env.AH_DISCORD_CHANNEL = "from-env";
		process.env.AH_SESSION_KEY = "env-session";

		const config = await resolveCliConfig({});
		expect(config.callbackUrl).toBe("https://hooks.example.test/from-env");
		expect(config.callbackToken).toBe("env-token");
		expect(config.discordChannel).toBe("from-env");
		expect(config.sessionKey).toBe("env-session");
	});
});
