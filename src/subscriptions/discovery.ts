import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
	DiscoverySourceConfig,
	SubscriptionConfig,
	SubscriptionDiscoveryConfig,
} from "../config.ts";

export type DiscoveredSubscription = {
	id: string;
	subscription: SubscriptionConfig;
	source: "discovered";
	provenance: DiscoveryProvenance;
};

export type DiscoveryProvenance = {
	discoveredAt: string;
	method:
		| "claude_source_dir"
		| "claude_token_file"
		| "claude_token_value"
		| "codex_source_dir"
		| "codex_api_key";
	locatorKind: "sourceDir" | "tokenFile" | "apiKey";
	locatorPath: string;
	label: string;
	candidateReasons: readonly string[];
	metadata: Record<string, string | number | boolean | null>;
};

type PathCandidate = {
	path: string;
	reasons: readonly string[];
};

type ProfileSourceResolution = {
	sourceName: string;
	source: DiscoverySourceConfig;
	value: string;
};

const DISCOVERY_CACHE_ROOT = resolve(tmpdir(), "agent-harness-discovery-cache");

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

function addReason(bucket: Map<string, Set<string>>, path: string, reason: string): void {
	const existing = bucket.get(path);
	if (existing) {
		existing.add(reason);
		return;
	}
	bucket.set(path, new Set([reason]));
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

function autoIdForClaudeTokenValue(label: string, token: string): string {
	const safeLabel = sanitizeIdSegment(label) || "profile";
	return `auto-claude-${safeLabel}-${shortHash(`token:${token}`)}`;
}

function autoIdForCodexDir(sourceDir: string): string {
	const base = basename(sourceDir);
	const labelRaw = base === ".codex" ? "default" : base.replace(/^\.codex-?/, "");
	const label = sanitizeIdSegment(labelRaw.length > 0 ? labelRaw : base) || "profile";
	return `auto-codex-${label}-${shortHash(sourceDir)}`;
}

function autoIdForCodexApiKey(label: string, apiKey: string): string {
	const safeLabel = sanitizeIdSegment(label) || "apikey";
	return `auto-codex-${safeLabel}-${shortHash(`apikey:${apiKey}`)}`;
}

function expandHomePath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
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
): Promise<readonly PathCandidate[]> {
	const home = homedir();
	const candidates = new Map<string, Set<string>>();
	if (includeDefaults) {
		addReason(candidates, normalizePath(defaultDir), "default_dir");
		if (envDir && envDir.trim().length > 0) {
			addReason(candidates, normalizePath(envDir), "env_dir");
		}
	}
	for (const dir of extraDirs) {
		const trimmed = dir.trim();
		if (trimmed.length === 0) continue;
		addReason(candidates, normalizePath(trimmed), "explicit_dir");
	}

	return (async () => {
		if (includeDefaults) {
			const names = await readDirNames(home);
			for (const name of names) {
				if (name.startsWith(prefix)) {
					addReason(candidates, normalizePath(join(home, name)), "home_prefix_scan");
				}
			}
		}
		return Array.from(candidates.entries())
			.map(([path, reasons]) => ({
				path,
				reasons: Array.from(reasons).sort((a, b) => a.localeCompare(b)),
			}))
			.sort((a, b) => a.path.localeCompare(b.path));
	})();
}

async function collectClaudeTokenFiles(
	extraPaths: readonly string[],
): Promise<readonly PathCandidate[]> {
	const candidates = new Map<string, Set<string>>();

	for (const value of extraPaths) {
		const trimmed = value.trim();
		if (trimmed.length === 0) continue;
		const normalized = normalizePath(trimmed);
		if (trimmed.endsWith(".token")) {
			addReason(candidates, normalized, "explicit_token_file");
			continue;
		}

		const entries = await readDirNamesWithTypes(normalized);
		if (entries.length > 0) {
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".token")) continue;
				addReason(
					candidates,
					normalizePath(join(normalized, entry.name)),
					"explicit_token_dir_scan",
				);
			}
			continue;
		}

		addReason(candidates, normalized, "explicit_token_path");
	}

	return Array.from(candidates.entries())
		.map(([path, reasons]) => ({
			path,
			reasons: Array.from(reasons).sort((a, b) => a.localeCompare(b)),
		}))
		.sort((a, b) => a.path.localeCompare(b.path));
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

function ensureUniqueId(baseId: string, usedIds: Set<string>): string {
	if (!usedIds.has(baseId)) {
		usedIds.add(baseId);
		return baseId;
	}
	let counter = 2;
	while (usedIds.has(`${baseId}-${counter}`)) {
		counter += 1;
	}
	const id = `${baseId}-${counter}`;
	usedIds.add(id);
	return id;
}

function selectJsonPath(value: unknown, jsonPath: string | undefined): unknown {
	if (!jsonPath) return value;
	const segments = jsonPath
		.split(".")
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
	let cursor: unknown = value;
	for (const segment of segments) {
		if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
			return null;
		}
		const record = cursor as Record<string, unknown>;
		cursor = record[segment];
	}
	return cursor;
}

async function resolveDiscoverySource(
	source: DiscoverySourceConfig,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	if (source.kind === "path") {
		return nonEmptyString(expandHomePath(source.value));
	}
	if (source.kind === "env") {
		const raw = env[source.name];
		return nonEmptyString(raw);
	}
	if (source.kind === "file") {
		const path = resolve(expandHomePath(source.path));
		if (!(await fileExists(path))) return null;
		if (source.format === "text") {
			const raw = await Bun.file(path)
				.text()
				.catch(() => "");
			return nonEmptyString(raw?.trim());
		}

		const json = await Bun.file(path)
			.json()
			.catch(() => null);
		const selected = selectJsonPath(json, source.jsonPath);
		return nonEmptyString(selected);
	}

	const proc = Bun.spawn([source.command, ...(source.args ?? [])], {
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const [code, stdout] = await Promise.all([
		proc.exited.catch(() => 1),
		new Response(proc.stdout).text().catch(() => ""),
	]);
	if (code !== 0) return null;
	return nonEmptyString(stdout?.trim());
}

async function resolveProfileSource(
	sources: Readonly<Record<string, DiscoverySourceConfig>>,
	sourceName: string,
	env: NodeJS.ProcessEnv,
): Promise<ProfileSourceResolution | null> {
	const source = sources[sourceName];
	if (!source) return null;
	const value = await resolveDiscoverySource(source, env);
	if (!value) return null;
	return { sourceName, source, value };
}

async function ensureDiscoveryCacheDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	try {
		await chmod(path, 0o700);
	} catch {
		// best effort
	}
}

async function materializeClaudeTokenFile(token: string): Promise<string> {
	const dir = join(DISCOVERY_CACHE_ROOT, "claude-tokens");
	await ensureDiscoveryCacheDir(dir);
	const filePath = join(dir, `${shortHash(`token:${token}`)}.token`);
	await writeFile(filePath, `${token}\n`, { mode: 0o600 });
	try {
		await chmod(filePath, 0o600);
	} catch {
		// best effort
	}
	return filePath;
}

async function materializeCodexApiKeyDir(apiKey: string): Promise<string> {
	const dir = join(DISCOVERY_CACHE_ROOT, "codex-apikey", shortHash(`apikey:${apiKey}`));
	await ensureDiscoveryCacheDir(dir);
	const authPath = join(dir, "auth.json");
	await writeFile(
		authPath,
		JSON.stringify(
			{
				auth_mode: "apikey",
				OPENAI_API_KEY: apiKey,
				last_refresh: new Date().toISOString(),
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	try {
		await chmod(authPath, 0o600);
	} catch {
		// best effort
	}
	return dir;
}

export async function discoverSubscriptions(
	discovery: SubscriptionDiscoveryConfig,
): Promise<readonly DiscoveredSubscription[]> {
	if (!discovery.enabled) return [];
	const now = new Date().toISOString();
	const claudeDirs = requirePathList("claudeDirs", discovery.claudeDirs);
	const codexDirs = requirePathList("codexDirs", discovery.codexDirs);
	const claudeTokenFiles = requirePathList("claudeTokenFiles", discovery.claudeTokenFiles);
	const sources = discovery.sources ?? {};
	const profiles = discovery.profiles ?? [];

	const discovered: DiscoveredSubscription[] = [];
	const seenSignatures = new Set<string>();
	const usedIds = new Set<string>();
	const seenClaudeTokenHashes = new Set<string>();
	const seenClaudeLabels = new Set<string>();

	function signatureFor(subscription: SubscriptionConfig): string {
		if (subscription.provider === "claude-code") {
			return `${subscription.provider}:${subscription.mode}:sourceDir=${subscription.sourceDir ?? ""}:tokenFile=${subscription.tokenFile ?? ""}`;
		}
		return `${subscription.provider}:${subscription.mode}:sourceDir=${subscription.sourceDir}:workspaceId=${subscription.workspaceId ?? ""}:enforce=${String(subscription.enforceWorkspace)}`;
	}

	function pushDiscovered(
		id: string,
		subscription: SubscriptionConfig,
		provenance: DiscoveryProvenance,
	): void {
		const signature = signatureFor(subscription);
		if (seenSignatures.has(signature)) return;
		seenSignatures.add(signature);
		discovered.push({
			id: ensureUniqueId(id, usedIds),
			source: "discovered",
			subscription,
			provenance,
		});
	}

	const claudeCandidates = await collectCandidateDirs(
		join(homedir(), ".claude"),
		".claude-",
		claudeDirs,
		// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
		process.env["CLAUDE_CONFIG_DIR"],
		discovery.includeDefaults,
	);
	for (const candidate of claudeCandidates) {
		const dir = candidate.path;
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

		pushDiscovered(
			autoIdForClaudeDir(dir),
			{
				provider: "claude-code",
				mode: "oauth",
				sourceDir: dir,
			},
			{
				discoveredAt: now,
				method: "claude_source_dir",
				locatorKind: "sourceDir",
				locatorPath: dir,
				label,
				candidateReasons: candidate.reasons,
				metadata: {
					credentialsPath,
					tokenFingerprint: token ? shortHash(token) : null,
				},
			},
		);
	}

	const claudeTokenFileCandidates = await collectClaudeTokenFiles(claudeTokenFiles);
	for (const candidate of claudeTokenFileCandidates) {
		const tokenFile = candidate.path;
		if (!(await fileExists(tokenFile))) continue;
		const tokenText = await Bun.file(tokenFile)
			.text()
			.catch(() => "");
		const token = tokenText.trim();
		if (token.length === 0 || !isLikelyClaudeOauthAccessToken(token)) continue;
		const label = claudeLabelFromTokenFile(tokenFile);
		if (seenClaudeLabels.has(label)) continue;
		const tokenHash = shortHash(`claude-token:${token}`);
		if (seenClaudeTokenHashes.has(tokenHash)) continue;
		seenClaudeTokenHashes.add(tokenHash);
		seenClaudeLabels.add(label);

		pushDiscovered(
			autoIdForClaudeTokenFile(tokenFile),
			{
				provider: "claude-code",
				mode: "oauth",
				tokenFile,
			},
			{
				discoveredAt: now,
				method: "claude_token_file",
				locatorKind: "tokenFile",
				locatorPath: tokenFile,
				label,
				candidateReasons: candidate.reasons,
				metadata: {
					tokenLength: token.length,
					tokenFingerprint: shortHash(token),
				},
			},
		);
	}

	const codexCandidates = await collectCandidateDirs(
		join(homedir(), ".codex"),
		".codex-",
		codexDirs,
		// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
		process.env["CODEX_HOME"],
		discovery.includeDefaults,
	);
	for (const candidate of codexCandidates) {
		const dir = candidate.path;
		const authPath = join(dir, "auth.json");
		if (!(await fileExists(authPath))) continue;
		const auth = await readJson(authPath);
		if (!auth) continue;

		const mode = inferCodexMode(auth);
		if (!mode) continue;
		const workspaceId = extractCodexAccountId(auth);
		const label = sanitizeIdSegment(
			basename(dir) === ".codex" ? "default" : basename(dir).replace(/^\.codex-?/, ""),
		);
		pushDiscovered(
			autoIdForCodexDir(dir),
			{
				provider: "codex",
				mode,
				sourceDir: dir,
				...(workspaceId ? { workspaceId } : {}),
				enforceWorkspace: false,
			},
			{
				discoveredAt: now,
				method: "codex_source_dir",
				locatorKind: "sourceDir",
				locatorPath: dir,
				label: label.length > 0 ? label : "profile",
				candidateReasons: candidate.reasons,
				metadata: {
					authPath,
					inferredMode: mode,
					workspaceId: workspaceId ?? null,
				},
			},
		);
	}

	for (const profile of profiles) {
		if (profile.enabled === false) continue;
		const resolvedSource = await resolveProfileSource(sources, profile.source, process.env);
		if (!resolvedSource) continue;

		const baseReasons = [`profile:${profile.source}`];
		if (profile.provider === "claude-code") {
			const mode = profile.mode ?? "oauth";
			const label = profile.label ?? sanitizeIdSegment(profile.source) ?? "profile";

			if (profile.valueType === "sourceDir") {
				const dir = normalizePath(expandHomePath(resolvedSource.value));
				const credentialsPath = join(dir, ".credentials.json");
				if (!(await fileExists(credentialsPath))) continue;
				pushDiscovered(
					profile.id ?? autoIdForClaudeDir(dir),
					{
						provider: "claude-code",
						mode,
						sourceDir: dir,
					},
					{
						discoveredAt: now,
						method: "claude_source_dir",
						locatorKind: "sourceDir",
						locatorPath: dir,
						label,
						candidateReasons: baseReasons,
						metadata: {
							credentialsPath,
							sourceKind: resolvedSource.source.kind,
						},
					},
				);
				continue;
			}

			if (profile.valueType === "tokenFile") {
				const tokenPath = normalizePath(expandHomePath(resolvedSource.value));
				const entries = await readDirNamesWithTypes(tokenPath);
				if (entries.length > 0) {
					for (const entry of entries) {
						if (!entry.isFile() || !entry.name.endsWith(".token")) continue;
						const tokenFile = normalizePath(join(tokenPath, entry.name));
						pushDiscovered(
							profile.id ?? autoIdForClaudeTokenFile(tokenFile),
							{
								provider: "claude-code",
								mode,
								tokenFile,
							},
							{
								discoveredAt: now,
								method: "claude_token_file",
								locatorKind: "tokenFile",
								locatorPath: tokenFile,
								label,
								candidateReasons: [...baseReasons, "token_dir_scan"],
								metadata: {
									sourceKind: resolvedSource.source.kind,
								},
							},
						);
					}
					continue;
				}

				pushDiscovered(
					profile.id ?? autoIdForClaudeTokenFile(tokenPath),
					{
						provider: "claude-code",
						mode,
						tokenFile: tokenPath,
					},
					{
						discoveredAt: now,
						method: "claude_token_file",
						locatorKind: "tokenFile",
						locatorPath: tokenPath,
						label,
						candidateReasons: baseReasons,
						metadata: {
							sourceKind: resolvedSource.source.kind,
						},
					},
				);
				continue;
			}

			const token = resolvedSource.value.trim();
			if (!isLikelyClaudeOauthAccessToken(token)) continue;
			const materializedTokenFile = await materializeClaudeTokenFile(token);
			pushDiscovered(
				profile.id ?? autoIdForClaudeTokenValue(label, token),
				{
					provider: "claude-code",
					mode,
					tokenFile: materializedTokenFile,
				},
				{
					discoveredAt: now,
					method: "claude_token_value",
					locatorKind: "tokenFile",
					locatorPath: materializedTokenFile,
					label,
					candidateReasons: baseReasons,
					metadata: {
						sourceKind: resolvedSource.source.kind,
						tokenFingerprint: shortHash(token),
					},
				},
			);
			continue;
		}

		const label = profile.label ?? sanitizeIdSegment(profile.source) ?? "profile";
		if (profile.valueType === "sourceDir") {
			const dir = normalizePath(expandHomePath(resolvedSource.value));
			const authPath = join(dir, "auth.json");
			if (!(await fileExists(authPath))) continue;
			const auth = await readJson(authPath);
			if (!auth) continue;
			const inferredMode = inferCodexMode(auth);
			const mode = profile.mode ?? inferredMode;
			if (!mode) continue;
			const workspaceId = profile.workspaceId ?? extractCodexAccountId(auth);
			pushDiscovered(
				profile.id ?? autoIdForCodexDir(dir),
				{
					provider: "codex",
					mode,
					sourceDir: dir,
					...(workspaceId ? { workspaceId } : {}),
					enforceWorkspace: profile.enforceWorkspace ?? false,
				},
				{
					discoveredAt: now,
					method: "codex_source_dir",
					locatorKind: "sourceDir",
					locatorPath: dir,
					label,
					candidateReasons: baseReasons,
					metadata: {
						authPath,
						sourceKind: resolvedSource.source.kind,
						inferredMode: inferredMode ?? null,
						workspaceId: workspaceId ?? null,
					},
				},
			);
			continue;
		}

		const apiKey = resolvedSource.value.trim();
		if (apiKey.length === 0) continue;
		const mode = profile.mode ?? "apikey";
		if (mode !== "apikey") continue;
		const sourceDir = await materializeCodexApiKeyDir(apiKey);
		pushDiscovered(
			profile.id ?? autoIdForCodexApiKey(label, apiKey),
			{
				provider: "codex",
				mode,
				sourceDir,
				enforceWorkspace: false,
			},
			{
				discoveredAt: now,
				method: "codex_api_key",
				locatorKind: "apiKey",
				locatorPath: sourceDir,
				label,
				candidateReasons: baseReasons,
				metadata: {
					sourceKind: resolvedSource.source.kind,
					apiKeyFingerprint: shortHash(apiKey),
				},
			},
		);
	}

	return discovered.sort((a, b) => a.id.localeCompare(b.id));
}
