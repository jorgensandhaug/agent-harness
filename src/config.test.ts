import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config.ts";

const cleanupPaths: string[] = [];

afterEach(async () => {
	for (const path of cleanupPaths.splice(0)) {
		await rm(path, { recursive: true, force: true });
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
		expect(config.tmuxPrefix).toBe("ah");
		expect(config.pollIntervalMs).toBe(1000);
		expect(Object.keys(config.providers).sort()).toEqual([
			"claude-code",
			"codex",
			"opencode",
			"pi",
		]);
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
});

describe("config/load.invalid-file", () => {
	it("throws strict, field-specific validation error", async () => {
		const dir = await makeTempDir();
		const path = join(dir, "harness.json");
		await writeFile(path, JSON.stringify({ port: "bad" }));

		await expect(loadConfig(path)).rejects.toThrow(/Invalid config: port:/);
	});
});
