import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSubscriptions } from "./discovery.ts";

const tempDirs: string[] = [];
const originalCloudgeniToken = process.env.CLOUDGENI_CLAUDE_TOKEN;
const originalOpenAiKey = process.env.OPENAI_API_KEY;

afterEach(async () => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
	if (originalCloudgeniToken === undefined) {
		process.env.CLOUDGENI_CLAUDE_TOKEN = undefined;
	} else {
		process.env.CLOUDGENI_CLAUDE_TOKEN = originalCloudgeniToken;
	}
	if (originalOpenAiKey === undefined) {
		process.env.OPENAI_API_KEY = undefined;
	} else {
		process.env.OPENAI_API_KEY = originalOpenAiKey;
	}
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("subscriptions/discovery", () => {
	it("returns empty list when discovery is disabled", async () => {
		const discovered = await discoverSubscriptions({
			enabled: false,
			includeDefaults: false,
			sources: {},
			profiles: [],
			claudeDirs: [],
			claudeTokenFiles: [],
			codexDirs: [],
		});
		expect(discovered).toEqual([]);
	});

	it("discovers claude + codex chatgpt profiles from explicit dirs", async () => {
		const root = await makeTempDir("ah-discovery-");
		const claudeDir = join(root, ".claude-work");
		const codexDir = join(root, ".codex-team");
		await mkdir(claudeDir, { recursive: true });
		await mkdir(codexDir, { recursive: true });

		await Bun.write(
			join(claudeDir, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: "sk-ant-oat01-test",
					scopes: ["user:inference"],
				},
			}),
		);
		await Bun.write(
			join(codexDir, "auth.json"),
			JSON.stringify({
				tokens: {
					id_token: "id-token",
					access_token: "access-token",
					refresh_token: "refresh-token",
					account_id: "acct_123",
				},
				last_refresh: "2026-02-18T00:00:00Z",
			}),
		);

		const discovered = await discoverSubscriptions({
			enabled: true,
			includeDefaults: false,
			sources: {},
			profiles: [],
			claudeDirs: [claudeDir],
			claudeTokenFiles: [],
			codexDirs: [codexDir],
		});

		expect(discovered.length).toBe(2);
		const claude = discovered.find((entry) => entry.subscription.provider === "claude-code");
		expect(claude?.provenance.method).toBe("claude_source_dir");
		expect(claude?.provenance.locatorPath).toBe(claudeDir);
		expect(claude?.subscription).toEqual({
			provider: "claude-code",
			mode: "oauth",
			sourceDir: claudeDir,
		});

		const codex = discovered.find((entry) => entry.subscription.provider === "codex");
		expect(codex?.provenance.method).toBe("codex_source_dir");
		expect(codex?.subscription).toEqual({
			provider: "codex",
			mode: "chatgpt",
			sourceDir: codexDir,
			workspaceId: "acct_123",
			enforceWorkspace: false,
		});
	});

	it("supports profile sources from env + file + command", async () => {
		const root = await makeTempDir("ah-discovery-profiles-");
		const tokenFile = join(root, "claude.token");
		const jsonFile = join(root, "keys.json");
		await Bun.write(tokenFile, "sk-ant-oat01-from-file\n");
		await Bun.write(
			jsonFile,
			JSON.stringify({
				secrets: {
					openai: "sk-from-json",
				},
			}),
		);

		process.env.CLOUDGENI_CLAUDE_TOKEN = "sk-ant-oat01-from-env";

		const discovered = await discoverSubscriptions({
			enabled: true,
			includeDefaults: false,
			sources: {
				claude_env: { kind: "env", name: "CLOUDGENI_CLAUDE_TOKEN" },
				claude_file: { kind: "path", value: tokenFile },
				openai_json: { kind: "file", path: jsonFile, format: "json", jsonPath: "secrets.openai" },
				claude_command: {
					kind: "command",
					command: "sh",
					args: ["-lc", "printf 'sk-ant-oat01-from-command'"],
				},
			},
			profiles: [
				{
					provider: "claude-code",
					source: "claude_env",
					valueType: "token",
					label: "env",
				},
				{
					provider: "claude-code",
					source: "claude_file",
					valueType: "tokenFile",
					label: "file",
				},
				{
					provider: "claude-code",
					source: "claude_command",
					valueType: "token",
					label: "command",
				},
				{
					provider: "codex",
					source: "openai_json",
					valueType: "apiKey",
					label: "json",
				},
			],
			claudeDirs: [],
			claudeTokenFiles: [],
			codexDirs: [],
		});

		const claudeSubs = discovered.filter((entry) => entry.subscription.provider === "claude-code");
		expect(claudeSubs.length).toBe(3);
		expect(claudeSubs.some((entry) => entry.provenance.method === "claude_token_value")).toBe(true);
		expect(claudeSubs.some((entry) => entry.provenance.method === "claude_token_file")).toBe(true);

		const codex = discovered.find((entry) => entry.subscription.provider === "codex");
		expect(codex).toBeDefined();
		expect(codex?.subscription.mode).toBe("apikey");
		expect(codex?.provenance.method).toBe("codex_api_key");
		if (codex && codex.subscription.provider === "codex") {
			const authJson = await Bun.file(join(codex.subscription.sourceDir, "auth.json")).json();
			expect(authJson).toMatchObject({
				auth_mode: "apikey",
				OPENAI_API_KEY: "sk-from-json",
			});
		}
	});

	it("respects explicit codex auth_mode=apikey when both token and key fields exist", async () => {
		const root = await makeTempDir("ah-discovery-");
		const codexDir = join(root, ".codex-mixed");
		await mkdir(codexDir, { recursive: true });
		await Bun.write(
			join(codexDir, "auth.json"),
			JSON.stringify({
				auth_mode: "apikey",
				OPENAI_API_KEY: "sk-test",
				tokens: {
					id_token: "id-token",
				},
			}),
		);

		const discovered = await discoverSubscriptions({
			enabled: true,
			includeDefaults: false,
			sources: {},
			profiles: [],
			claudeDirs: [],
			claudeTokenFiles: [],
			codexDirs: [codexDir],
		});

		expect(discovered).toHaveLength(1);
		expect(discovered[0]?.subscription).toEqual({
			provider: "codex",
			mode: "apikey",
			sourceDir: codexDir,
			enforceWorkspace: false,
		});
		expect(discovered[0]?.provenance.method).toBe("codex_source_dir");
	});

	it("discovers claude token files and de-dupes by token value", async () => {
		const root = await makeTempDir("ah-discovery-");
		const claudeDir = join(root, ".claude-default");
		await mkdir(claudeDir, { recursive: true });
		const defaultToken = "sk-ant-oat01-default";
		const cloudgeniToken = "sk-ant-oat01-cloudgeni";

		await Bun.write(
			join(claudeDir, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: defaultToken,
					scopes: ["user:inference"],
				},
			}),
		);

		const duplicateTokenFile = join(root, "default.token");
		const distinctTokenFile = join(root, "cloudgeni.token");
		await Bun.write(duplicateTokenFile, `${defaultToken}\n`);
		await Bun.write(distinctTokenFile, `${cloudgeniToken}\n`);

		const discovered = await discoverSubscriptions({
			enabled: true,
			includeDefaults: false,
			sources: {},
			profiles: [],
			claudeDirs: [claudeDir],
			claudeTokenFiles: [duplicateTokenFile, distinctTokenFile],
			codexDirs: [],
		});

		const claudeSubs = discovered.filter((entry) => entry.subscription.provider === "claude-code");
		expect(claudeSubs).toHaveLength(2);
		expect(
			claudeSubs.some(
				(entry) =>
					entry.subscription.provider === "claude-code" &&
					typeof entry.subscription.sourceDir === "string" &&
					entry.subscription.sourceDir === claudeDir,
			),
		).toBe(true);
		expect(
			claudeSubs.some(
				(entry) =>
					entry.subscription.provider === "claude-code" &&
					typeof entry.subscription.tokenFile === "string" &&
					entry.subscription.tokenFile === distinctTokenFile &&
					entry.provenance.method === "claude_token_file",
			),
		).toBe(true);
	});
});
