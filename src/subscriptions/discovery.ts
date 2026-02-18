import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SubscriptionConfig, SubscriptionDiscoveryConfig } from "../config.ts";

export type DiscoveredSubscription = {
	id: string;
	subscription: SubscriptionConfig;
	source: "discovered";
};

function normalizePath(path: string): string {
	return resolve(path);
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function sanitizeIdSegment(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "");
}

function shortHash(value: string): string {
	return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function autoIdFor(provider: "claude-code" | "codex", sourceDir: string): string {
	const base = basename(sourceDir);
	const labelRaw =
		provider === "claude-code"
			? base === ".claude"
				? "default"
				: base.replace(/^\.claude-?/, "")
			: base === ".codex"
				? "default"
				: base.replace(/^\.codex-?/, "");
	const label = sanitizeIdSegment(labelRaw.length > 0 ? labelRaw : base) || "profile";
	const prefix = provider === "claude-code" ? "auto-claude" : "auto-codex";
	return `${prefix}-${label}-${shortHash(sourceDir)}`;
}

async function readDirNames(path: string): Promise<readonly string[]> {
	try {
		return await readdir(path);
	} catch {
		return [];
	}
}

async function fileExists(path: string): Promise<boolean> {
	return Bun.file(path).exists();
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
	try {
		const raw: unknown = await Bun.file(path).json();
		return parseJsonObject(raw);
	} catch {
		return null;
	}
}

function collectCandidateDirs(
	defaultDir: string,
	prefix: string,
	extraDirs: readonly string[],
	envDir: string | undefined,
	includeDefaults: boolean,
): Promise<readonly string[]> {
	const home = homedir();
	const candidates = new Set<string>();
	if (includeDefaults) {
		candidates.add(normalizePath(defaultDir));
		if (envDir && envDir.trim().length > 0) {
			candidates.add(normalizePath(envDir));
		}
	}
	for (const dir of extraDirs) {
		const trimmed = dir.trim();
		if (trimmed.length === 0) continue;
		candidates.add(normalizePath(trimmed));
	}

	return (async () => {
		if (includeDefaults) {
			const names = await readDirNames(home);
			for (const name of names) {
				if (name.startsWith(prefix)) {
					candidates.add(normalizePath(join(home, name)));
				}
			}
		}
		return Array.from(candidates).sort((a, b) => a.localeCompare(b));
	})();
}

function inferCodexMode(auth: Record<string, unknown>): "chatgpt" | "apikey" | null {
	const explicitMode = nonEmptyString(auth.auth_mode);
	if (explicitMode === "chatgpt" || explicitMode === "apikey") {
		return explicitMode;
	}

	const apiKey = nonEmptyString(auth.OPENAI_API_KEY);
	const tokens = parseJsonObject(auth.tokens);
	const hasTokens = Boolean(
		tokens &&
			(nonEmptyString(tokens.id_token) ||
				nonEmptyString(tokens.access_token) ||
				nonEmptyString(tokens.refresh_token) ||
				nonEmptyString(tokens.account_id)),
	);

	if (hasTokens) return "chatgpt";
	if (apiKey) return "apikey";
	return null;
}

function extractCodexAccountId(auth: Record<string, unknown>): string | undefined {
	const tokens = parseJsonObject(auth.tokens);
	if (!tokens) return undefined;
	const accountId = nonEmptyString(tokens.account_id);
	return accountId ?? undefined;
}

export async function discoverSubscriptions(
	discovery: SubscriptionDiscoveryConfig,
): Promise<readonly DiscoveredSubscription[]> {
	if (!discovery.enabled) return [];

	const claudeCandidates = await collectCandidateDirs(
		join(homedir(), ".claude"),
		".claude-",
		discovery.claudeDirs,
		// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
		process.env["CLAUDE_CONFIG_DIR"],
		discovery.includeDefaults,
	);
	const codexCandidates = await collectCandidateDirs(
		join(homedir(), ".codex"),
		".codex-",
		discovery.codexDirs,
		// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
		process.env["CODEX_HOME"],
		discovery.includeDefaults,
	);

	const discovered: DiscoveredSubscription[] = [];

	for (const dir of claudeCandidates) {
		const credentialsPath = join(dir, ".credentials.json");
		if (!(await fileExists(credentialsPath))) continue;
		const id = autoIdFor("claude-code", dir);
		discovered.push({
			id,
			source: "discovered",
			subscription: {
				provider: "claude-code",
				mode: "oauth",
				sourceDir: dir,
			},
		});
	}

	for (const dir of codexCandidates) {
		const authPath = join(dir, "auth.json");
		if (!(await fileExists(authPath))) continue;
		const auth = await readJson(authPath);
		if (!auth) continue;

		const mode = inferCodexMode(auth);
		if (!mode) continue;
		const workspaceId = extractCodexAccountId(auth);
		const id = autoIdFor("codex", dir);
		discovered.push({
			id,
			source: "discovered",
			subscription: {
				provider: "codex",
				mode,
				sourceDir: dir,
				...(workspaceId ? { workspaceId } : {}),
				enforceWorkspace: false,
			},
		});
	}

	return discovered.sort((a, b) => a.id.localeCompare(b.id));
}
