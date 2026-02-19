import { join } from "node:path";
import { z } from "zod";

const CliFileConfigSchema = z
	.object({
		url: z.string().url().optional(),
		token: z.string().min(1).optional(),
		json: z.boolean().optional(),
		compact: z.boolean().optional(),
	})
	.strict();

export type CliFileConfig = z.infer<typeof CliFileConfigSchema>;

export type CliFlagOverrides = {
	url?: string | undefined;
	token?: string | undefined;
	json?: boolean | undefined;
	compact?: boolean | undefined;
};

export type CliRuntimeConfig = {
	url: string;
	token?: string | undefined;
	json: boolean;
	compact: boolean;
	configPath: string;
};

const DEFAULT_URL = "http://127.0.0.1:7070";

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new Error(`Invalid boolean value '${value}'`);
}

function normalizeUrl(url: string): string {
	const trimmed = url.trim();
	if (trimmed.length === 0) {
		throw new Error("CLI URL must be a non-empty string");
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`Invalid CLI URL: '${url}'`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported CLI URL protocol '${parsed.protocol}'. Use http:// or https://`);
	}
	return parsed.toString().replace(/\/+$/, "");
}

function defaultCliConfigCandidates(): string[] {
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const xdgConfigHome = nonEmpty(process.env["XDG_CONFIG_HOME"]);
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const homeDir = nonEmpty(process.env["HOME"]);
	if (xdgConfigHome) {
		return [join(xdgConfigHome, "agent-harness", "cli.json")];
	}
	if (homeDir) {
		return [join(homeDir, ".config", "agent-harness", "cli.json")];
	}
	return ["cli.json"];
}

async function resolveConfigPath(): Promise<string> {
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const envPath = nonEmpty(process.env["AH_CONFIG"]);
	if (envPath) return envPath;
	const candidates = defaultCliConfigCandidates();
	for (const candidate of candidates) {
		const file = Bun.file(candidate);
		if (await file.exists()) {
			return candidate;
		}
	}
	return candidates[0] ?? "cli.json";
}

async function readCliFileConfig(configPath: string): Promise<CliFileConfig> {
	const file = Bun.file(configPath);
	if (!(await file.exists())) {
		return {};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(await file.text());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid client config JSON at '${configPath}': ${message}`);
	}
	const parsed = CliFileConfigSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
		throw new Error(`Invalid client config at '${configPath}': ${issues.join("; ")}`);
	}
	return parsed.data;
}

export async function resolveCliConfig(overrides: CliFlagOverrides): Promise<CliRuntimeConfig> {
	const configPath = await resolveConfigPath();
	const fileConfig = await readCliFileConfig(configPath);

	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const envUrl = nonEmpty(process.env["AH_URL"]);
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const envToken = nonEmpty(process.env["AH_TOKEN"]);
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const envJson = parseBooleanEnv(process.env["AH_JSON"]);
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const envCompact = parseBooleanEnv(process.env["AH_COMPACT"]);

	const url = normalizeUrl(overrides.url ?? envUrl ?? fileConfig.url ?? DEFAULT_URL);
	const token = nonEmpty(overrides.token) ?? envToken ?? fileConfig.token;
	const json = overrides.json ?? envJson ?? fileConfig.json ?? false;
	const compact = overrides.compact ?? envCompact ?? fileConfig.compact ?? false;

	return {
		url,
		...(token ? { token } : {}),
		json,
		compact,
		configPath,
	};
}
