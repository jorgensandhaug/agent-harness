import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSubscriptions } from "./discovery.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await rm(dir, { recursive: true, force: true });
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
			claudeDirs: [claudeDir],
			claudeTokenFiles: [],
			codexDirs: [codexDir],
		});

		expect(discovered.length).toBe(2);
		const claude = discovered.find((entry) => entry.subscription.provider === "claude-code");
		expect(claude?.source).toBe("discovered");
		expect(claude?.provenance.method).toBe("claude_source_dir");
		expect(claude?.provenance.locatorPath).toBe(claudeDir);
		expect(claude?.subscription).toEqual({
			provider: "claude-code",
			mode: "oauth",
			sourceDir: claudeDir,
		});
		expect(claude?.id.startsWith("auto-claude-")).toBe(true);

		const codex = discovered.find((entry) => entry.subscription.provider === "codex");
		expect(codex?.source).toBe("discovered");
		expect(codex?.provenance.method).toBe("codex_source_dir");
		expect(codex?.subscription).toEqual({
			provider: "codex",
			mode: "chatgpt",
			sourceDir: codexDir,
			workspaceId: "acct_123",
			enforceWorkspace: false,
		});
		expect(codex?.id.startsWith("auto-codex-")).toBe(true);
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
