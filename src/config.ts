import { z } from "zod";
import { log } from "./log.ts";

const ProviderConfigSchema = z
	.object({
		command: z.string(),
		extraArgs: z.array(z.string()).default([]),
		env: z.record(z.string()).default({}),
		model: z.string().optional(),
		enabled: z.boolean().default(true),
	})
	.strict();

const AuthConfigSchema = z
	.object({
		token: z.string().min(1).optional(),
	})
	.strict();

const HarnessConfigSchema = z
	.object({
		port: z.number().int().min(1).max(65535).default(7070),
		tmuxPrefix: z.string().min(1).default("ah"),
		logDir: z.string().default("./logs"),
		logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
		pollIntervalMs: z.number().int().min(100).max(30000).default(1000),
		captureLines: z.number().int().min(10).max(10000).default(500),
		maxEventHistory: z.number().int().min(100).max(100000).default(10000),
		auth: AuthConfigSchema.optional(),
		providers: z.record(ProviderConfigSchema).default({
			"claude-code": {
				command: "claude",
				extraArgs: ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions"],
				env: {},
				enabled: true,
			},
			codex: {
				command: "codex",
				extraArgs: ["--yolo"],
				env: {},
				enabled: true,
			},
			pi: {
				command: "pi",
				extraArgs: [],
				env: {},
				enabled: true,
			},
			opencode: {
				command: "opencode",
				extraArgs: [],
				env: {},
				enabled: true,
			},
		}),
	})
	.strict();

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export async function loadConfig(path?: string): Promise<HarnessConfig> {
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const configPath = path ?? process.env["HARNESS_CONFIG"] ?? "harness.json";

	let raw: unknown = {};
	try {
		const file = Bun.file(configPath);
		if (await file.exists()) {
			const text = await file.text();
			raw = JSON.parse(text);
			log.info("config loaded", { path: configPath });
		} else {
			log.info("no config file found, using defaults", { path: configPath });
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		log.warn("failed to read config file, using defaults", {
			path: configPath,
			error: msg,
		});
	}

	const result = HarnessConfigSchema.safeParse(raw);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
		throw new Error(`Invalid config: ${issues.join("; ")}`);
	}

	const config = result.data;
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const authTokenFromEnv = process.env["AH_AUTH_TOKEN"];
	if (typeof authTokenFromEnv === "string" && authTokenFromEnv.trim().length > 0) {
		return {
			...config,
			auth: {
				...(config.auth ?? {}),
				token: authTokenFromEnv.trim(),
			},
		};
	}

	return config;
}
