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

const WebhookEventSchema = z.enum(["agent_completed", "agent_error", "agent_exited"]);

const WebhookSafetyNetConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		intervalMs: z.number().int().min(1000).max(300000).default(30000),
		stuckAfterMs: z.number().int().min(1000).max(86400000).default(180000),
		stuckWarnIntervalMs: z.number().int().min(1000).max(86400000).default(300000),
	})
	.strict();

const WebhookConfigSchema = z
	.object({
		url: z.string().url(),
		token: z.string().min(1).optional(),
		events: z.array(WebhookEventSchema).min(1),
		safetyNet: WebhookSafetyNetConfigSchema.default({
			enabled: false,
			intervalMs: 30000,
			stuckAfterMs: 180000,
			stuckWarnIntervalMs: 300000,
		}),
	})
	.strict();

const AuthConfigSchema = z
	.object({
		token: z.string().min(1).optional(),
	})
	.strict();

const ClaudeSubscriptionSchema = z
	.object({
		provider: z.literal("claude-code"),
		mode: z.literal("oauth").default("oauth"),
		sourceDir: z.string().min(1).optional(),
		tokenFile: z.string().min(1).optional(),
		expected: z
			.object({
				subscriptionType: z.string().min(1).optional(),
				rateLimitTier: z.string().min(1).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const CodexSubscriptionSchema = z
	.object({
		provider: z.literal("codex"),
		mode: z.enum(["chatgpt", "apikey"]).default("chatgpt"),
		sourceDir: z.string().min(1),
		workspaceId: z.string().min(1).optional(),
		enforceWorkspace: z.boolean().default(false),
	})
	.strict();

const SubscriptionConfigSchema = z.discriminatedUnion("provider", [
	ClaudeSubscriptionSchema,
	CodexSubscriptionSchema,
]);

const SubscriptionDiscoveryConfigSchema = z
	.object({
		enabled: z.boolean().default(true),
		includeDefaults: z.boolean().default(true),
		claudeDirs: z.array(z.string().min(1)).default([]),
		claudeTokenFiles: z.array(z.string().min(1)).default([]),
		codexDirs: z.array(z.string().min(1)).default([]),
	})
	.strict();

const HarnessConfigSchema = z
	.object({
		port: z.number().int().min(1).max(65535).default(7070),
		bindAddress: z.string().min(1).default("127.0.0.1"),
		tmuxPrefix: z.string().min(1).default("ah"),
		logDir: z.string().default("./logs"),
		logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
		pollIntervalMs: z.number().int().min(100).max(30000).default(1000),
		captureLines: z.number().int().min(10).max(10000).default(500),
		maxEventHistory: z.number().int().min(100).max(100000).default(10000),
		auth: AuthConfigSchema.optional(),
		webhook: WebhookConfigSchema.optional(),
		subscriptions: z.record(SubscriptionConfigSchema).default({}),
		subscriptionDiscovery: SubscriptionDiscoveryConfigSchema.optional(),
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
	.strict()
	.superRefine((value, ctx) => {
		for (const [id, subscription] of Object.entries(value.subscriptions)) {
			if (subscription.provider === "claude-code") {
				const hasSourceDir =
					typeof subscription.sourceDir === "string" && subscription.sourceDir.trim().length > 0;
				const hasTokenFile =
					typeof subscription.tokenFile === "string" && subscription.tokenFile.trim().length > 0;
				if (!hasSourceDir && !hasTokenFile) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ["subscriptions", id, "sourceDir"],
						message: "either sourceDir or tokenFile is required for claude oauth subscription",
					});
				}
				if (hasSourceDir && hasTokenFile) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ["subscriptions", id, "tokenFile"],
						message: "sourceDir and tokenFile are mutually exclusive",
					});
				}
			}
			if (
				subscription.provider === "codex" &&
				subscription.enforceWorkspace &&
				(!subscription.workspaceId || subscription.workspaceId.trim().length === 0)
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["subscriptions", id, "workspaceId"],
					message: "workspaceId is required when enforceWorkspace=true",
				});
			}
		}
	});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
export type WebhookSafetyNetConfig = z.infer<typeof WebhookSafetyNetConfigSchema>;
export type SubscriptionConfig = z.infer<typeof SubscriptionConfigSchema>;
export type SubscriptionDiscoveryConfig = z.infer<typeof SubscriptionDiscoveryConfigSchema>;

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

	let config = result.data;
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const authTokenFromEnv = process.env["AH_AUTH_TOKEN"];
	if (typeof authTokenFromEnv === "string" && authTokenFromEnv.trim().length > 0) {
		config = {
			...config,
			auth: {
				...(config.auth ?? {}),
				token: authTokenFromEnv.trim(),
			},
		};
	}

	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const webhookTokenFromEnv = process.env["AH_WEBHOOK_TOKEN"];
	if (
		typeof webhookTokenFromEnv === "string" &&
		webhookTokenFromEnv.trim().length > 0 &&
		config.webhook
	) {
		config = {
			...config,
			webhook: {
				...config.webhook,
				token: webhookTokenFromEnv.trim(),
			},
		};
	}

	if (!config.subscriptionDiscovery) {
		config = {
			...config,
			subscriptionDiscovery: {
				enabled: true,
				includeDefaults: true,
				claudeDirs: [],
				claudeTokenFiles: [],
				codexDirs: [],
			},
		};
	}

	return config;
}
