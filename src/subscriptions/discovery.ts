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

function claudeLabelFromDir(sourceDir: string): string {
	const base = basename(sourceDir);
	const labelRaw = base === ".claude" ? "default" : base.replace(/^\.claude-?/, "");
	return sanitizeIdSegment(labelRaw.length > 0 ? labelRaw : base) || "profile";
}

function claudeLabelFromTokenFile(tokenFile: string): string {
	const base = basename(tokenFile).replace(/\.token$/i, "");
	return sanitizeIdSegment(base) || "profile";
}

function autoIdForClaudeDir(sourceDir: string): string {
	const label = claudeLabelFromDir(sourceDir);
	return `auto-claude-${label}-${shortHash(sourceDir)}`;
}

function autoIdForClaudeTokenFile(tokenFile: string): string {
	const label = claudeLabelFromTokenFile(tokenFile);
	return `auto-claude-${label}-${shortHash(tokenFile)}`;
}

function autoIdForCodexDir(sourceDir: string): string {
	const base = basename(sourceDir);
	const labelRaw = base === ".codex" ? "default" : base.replace(/^\.codex-?/, "");
	const label = sanitizeIdSegment(labelRaw.length > 0 ? labelRaw : base) || "profile";
	return `auto-codex-${label}-${shortHash(sourceDir)}`;
}

async function readDirNames(path: string): Promise<readonly string[]> {
	try {
		return await readdir(path);
	} catch {
		return [];
	}
}

async function readDirNamesWithTypes(path: string) {
	try {
		return await readdir(path, { withFileTypes: true });
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

async function collectClaudeTokenFiles(
	extraPaths: readonly string[],
	includeDefaults: boolean,
): Promise<readonly string[]> {
	const candidates = new Set<string>();
	if (includeDefaults) {
		const defaultDirs = [
			join(homedir(), "dotfiles", "secrets", "profiles", "claude"),
			join(homedir(), "dotfiles", "secrets", "vm1", "profiles", "claude"),
		];
		for (const dir of defaultDirs) {
			const entries = await readDirNamesWithTypes(dir);
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".token")) continue;
				candidates.add(normalizePath(join(dir, entry.name)));
			}
		}
	}

	for (const value of extraPaths) {
		const trimmed = value.trim();
		if (trimmed.length === 0) continue;
		const normalized = normalizePath(trimmed);
		if (trimmed.endsWith(".token")) {
			candidates.add(normalized);
			continue;
		}

		const entries = await readDirNamesWithTypes(normalized);
		if (entries.length > 0) {
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".token")) continue;
				candidates.add(normalizePath(join(normalized, entry.name)));
			}
			continue;
		}

		candidates.add(normalized);
	}

	return Array.from(candidates).sort((a, b) => a.localeCompare(b));
}

function requirePathList(
	field: "claudeDirs" | "codexDirs" | "claudeTokenFiles",
	value: readonly string[] | undefined,
): readonly string[] {
	if (!Array.isArray(value)) {
		throw new Error(`invalid subscription discovery config: ${field} must be defined`);
	}
	return value;
}

function extractClaudeAccessToken(raw: Record<string, unknown>): string | null {
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const oauth = parseJsonObject(raw["claudeAiOauth"]);
	if (!oauth) return null;
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	return nonEmptyString(oauth["accessToken"]);
}

function isLikelyClaudeOauthAccessToken(token: string): boolean {
	return /^sk-ant-oat\d{2}-/i.test(token);
}

function inferCodexMode(auth: Record<string, unknown>): "chatgpt" | "apikey" | null {
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const explicitMode = nonEmptyString(auth["auth_mode"]);
	if (explicitMode === "chatgpt" || explicitMode === "apikey") {
		return explicitMode;
	}

	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const apiKey = nonEmptyString(auth["OPENAI_API_KEY"]);
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const tokens = parseJsonObject(auth["tokens"]);
	const hasTokens = Boolean(
		tokens &&
			// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
			(nonEmptyString(tokens["id_token"]) ||
				// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
				nonEmptyString(tokens["access_token"]) ||
				// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
				nonEmptyString(tokens["refresh_token"]) ||
				// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
				nonEmptyString(tokens["account_id"])),
	);

	if (hasTokens) return "chatgpt";
	if (apiKey) return "apikey";
	return null;
}

function extractCodexAccountId(auth: Record<string, unknown>): string | undefined {
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const tokens = parseJsonObject(auth["tokens"]);
	if (!tokens) return undefined;
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const accountId = nonEmptyString(tokens["account_id"]);
	return accountId ?? undefined;
}

export async function discoverSubscriptions(
	discovery: SubscriptionDiscoveryConfig,
): Promise<readonly DiscoveredSubscription[]> {
	if (!discovery.enabled) return [];
	const claudeDirs = requirePathList("claudeDirs", discovery.claudeDirs);
	const codexDirs = requirePathList("codexDirs", discovery.codexDirs);
	const claudeTokenFiles = requirePathList("claudeTokenFiles", discovery.claudeTokenFiles);

	const claudeCandidates = await collectCandidateDirs(
		join(homedir(), ".claude"),
		".claude-",
		claudeDirs,
		// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
		process.env["CLAUDE_CONFIG_DIR"],
		discovery.includeDefaults,
	);
	const codexCandidates = await collectCandidateDirs(
		join(homedir(), ".codex"),
		".codex-",
		codexDirs,
		// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
		process.env["CODEX_HOME"],
		discovery.includeDefaults,
	);
	const claudeTokenFileCandidates = await collectClaudeTokenFiles(
		claudeTokenFiles,
		discovery.includeDefaults,
	);

	const discovered: DiscoveredSubscription[] = [];
	const seenClaudeTokenHashes = new Set<string>();
	const seenClaudeLabels = new Set<string>();

	for (const dir of claudeCandidates) {
		const credentialsPath = join(dir, ".credentials.json");
		if (!(await fileExists(credentialsPath))) continue;
		const label = claudeLabelFromDir(dir);
		if (seenClaudeLabels.has(label)) continue;
		const parsedCredentials = await readJson(credentialsPath);
		const token = parsedCredentials ? extractClaudeAccessToken(parsedCredentials) : null;
		if (token) {
			const tokenHash = shortHash(`claude-token:${token}`);
			if (seenClaudeTokenHashes.has(tokenHash)) continue;
			seenClaudeTokenHashes.add(tokenHash);
		}
		seenClaudeLabels.add(label);

		const id = autoIdForClaudeDir(dir);
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

	for (const tokenFile of claudeTokenFileCandidates) {
		if (!(await fileExists(tokenFile))) continue;
		const tokenText = await Bun.file(tokenFile)
			.text()
			.catch(() => "");
		const token = tokenText.trim();
		if (token.length === 0) continue;
		if (!isLikelyClaudeOauthAccessToken(token)) continue;
		const label = claudeLabelFromTokenFile(tokenFile);
		if (seenClaudeLabels.has(label)) continue;
		const tokenHash = shortHash(`claude-token:${token}`);
		if (seenClaudeTokenHashes.has(tokenHash)) continue;
		seenClaudeTokenHashes.add(tokenHash);
		seenClaudeLabels.add(label);

		const id = autoIdForClaudeTokenFile(tokenFile);
		discovered.push({
			id,
			source: "discovered",
			subscription: {
				provider: "claude-code",
				mode: "oauth",
				tokenFile,
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
		const id = autoIdForCodexDir(dir);
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
