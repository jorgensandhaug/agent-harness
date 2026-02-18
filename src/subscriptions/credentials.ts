import { join } from "node:path";
import { z } from "zod";
import type { SubscriptionConfig } from "../config.ts";

const ClaudeCredentialsSchema = z
	.object({
		claudeAiOauth: z
			.object({
				accessToken: z.string(),
				refreshToken: z.string().optional(),
				expiresAt: z.number().nullable().optional(),
				scopes: z.array(z.string()).optional(),
				subscriptionType: z.string().nullable().optional(),
				rateLimitTier: z.string().nullable().optional(),
			})
			.strict(),
	})
	.strict();

const CodexAuthSchema = z
	.object({
		OPENAI_API_KEY: z.string().nullable().optional(),
		auth_mode: z.string().optional(),
		last_refresh: z.string().optional(),
		tokens: z
			.object({
				id_token: z.string().optional(),
				access_token: z.string().optional(),
				refresh_token: z.string().optional(),
				account_id: z.string().optional(),
			})
			.optional(),
	})
	.passthrough();

type MetadataValue = string | number | boolean | null;
type Summary = {
	id: string;
	provider: SubscriptionConfig["provider"];
	mode: string;
	sourceDir: string;
	valid: boolean;
	reason: string | null;
	metadata: Record<string, MetadataValue>;
};

function claudeSourceRef(
	subscription: Extract<SubscriptionConfig, { provider: "claude-code" }>,
): string {
	if (typeof subscription.sourceDir === "string" && subscription.sourceDir.trim().length > 0) {
		return subscription.sourceDir;
	}
	if (typeof subscription.tokenFile === "string" && subscription.tokenFile.trim().length > 0) {
		return subscription.tokenFile;
	}
	throw new Error("claude subscription missing sourceDir/tokenFile");
}

type CodexOrganizationClaim = {
	title?: string;
	is_default?: boolean;
};

type CodexAuthClaim = {
	chatgpt_plan_type?: string;
	chatgpt_subscription_active_until?: string;
	organizations?: readonly CodexOrganizationClaim[];
};

type CodexJwtPayload = {
	email?: string;
	"https://api.openai.com/auth"?: CodexAuthClaim;
};

async function readJson(path: string): Promise<unknown | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	try {
		return await file.json();
	} catch {
		return null;
	}
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	const payloadPart = parts[1];
	if (!payloadPart) return null;
	try {
		const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const json = Buffer.from(padded, "base64").toString();
		const decoded: unknown = JSON.parse(json);
		if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
		return decoded as Record<string, unknown>;
	} catch {
		return null;
	}
}

function codexJwtMetadata(idToken: string): Record<string, MetadataValue> {
	const rawPayload = decodeJwtPayload(idToken);
	if (!rawPayload) {
		return {
			jwtDecoded: false,
			email: null,
			plan: null,
			subscriptionActiveUntil: null,
			defaultOrgTitle: null,
		};
	}

	const payload = rawPayload as CodexJwtPayload;
	const authObj = payload["https://api.openai.com/auth"] ?? null;
	const organizations = Array.isArray(authObj?.organizations)
		? authObj.organizations.filter((o): o is CodexOrganizationClaim => {
				return typeof o === "object" && o !== null && !Array.isArray(o);
			})
		: [];
	const defaultOrg = organizations.find((o) => o.is_default === true) ?? organizations[0];
	const defaultOrgTitle =
		defaultOrg && typeof defaultOrg.title === "string" ? defaultOrg.title : null;
	const email = typeof payload.email === "string" ? payload.email : null;
	const plan =
		authObj && typeof authObj.chatgpt_plan_type === "string" ? authObj.chatgpt_plan_type : null;
	const subscriptionActiveUntil =
		authObj && typeof authObj.chatgpt_subscription_active_until === "string"
			? authObj.chatgpt_subscription_active_until
			: null;

	return {
		jwtDecoded: true,
		email,
		plan,
		subscriptionActiveUntil,
		defaultOrgTitle,
	};
}

function summarizeClaude(
	id: string,
	subscription: Extract<SubscriptionConfig, { provider: "claude-code" }>,
	credentials: z.output<typeof ClaudeCredentialsSchema>,
): Summary {
	const sourceRef = claudeSourceRef(subscription);
	const oauth = credentials.claudeAiOauth;
	const scopes = oauth.scopes ?? [];
	const hasInferenceScope = scopes.includes("user:inference");
	if (!hasInferenceScope) {
		return {
			id,
			provider: subscription.provider,
			mode: subscription.mode,
			sourceDir: sourceRef,
			valid: false,
			reason: "missing required scope user:inference",
			metadata: {
				scopesCount: scopes.length,
				subscriptionType: oauth.subscriptionType ?? null,
				rateLimitTier: oauth.rateLimitTier ?? null,
			},
		};
	}

	if (
		subscription.expected?.subscriptionType &&
		subscription.expected.subscriptionType !== (oauth.subscriptionType ?? null)
	) {
		return {
			id,
			provider: subscription.provider,
			mode: subscription.mode,
			sourceDir: sourceRef,
			valid: false,
			reason: `subscriptionType mismatch (expected ${subscription.expected.subscriptionType})`,
			metadata: {
				subscriptionType: oauth.subscriptionType ?? null,
				rateLimitTier: oauth.rateLimitTier ?? null,
				scopesCount: scopes.length,
			},
		};
	}

	if (
		subscription.expected?.rateLimitTier &&
		subscription.expected.rateLimitTier !== (oauth.rateLimitTier ?? null)
	) {
		return {
			id,
			provider: subscription.provider,
			mode: subscription.mode,
			sourceDir: sourceRef,
			valid: false,
			reason: `rateLimitTier mismatch (expected ${subscription.expected.rateLimitTier})`,
			metadata: {
				subscriptionType: oauth.subscriptionType ?? null,
				rateLimitTier: oauth.rateLimitTier ?? null,
				scopesCount: scopes.length,
			},
		};
	}

	return {
		id,
		provider: subscription.provider,
		mode: subscription.mode,
		sourceDir: sourceRef,
		valid: true,
		reason: null,
		metadata: {
			scopesCount: scopes.length,
			hasRefreshToken: typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0,
			subscriptionType: oauth.subscriptionType ?? null,
			rateLimitTier: oauth.rateLimitTier ?? null,
			expiresAtMs: oauth.expiresAt ?? null,
		},
	};
}

async function summarizeClaudeTokenFile(
	id: string,
	subscription: Extract<SubscriptionConfig, { provider: "claude-code" }>,
	tokenFile: string,
): Promise<Summary> {
	const tokenText = await Bun.file(tokenFile)
		.text()
		.catch(() => null);
	const token = typeof tokenText === "string" ? tokenText.trim() : "";
	if (token.length === 0) {
		return {
			id,
			provider: subscription.provider,
			mode: subscription.mode,
			sourceDir: tokenFile,
			valid: false,
			reason: "missing or unreadable tokenFile",
			metadata: {},
		};
	}

	return {
		id,
		provider: subscription.provider,
		mode: subscription.mode,
		sourceDir: tokenFile,
		valid: true,
		reason: null,
		metadata: {
			tokenLength: token.length,
			expectedChecksSkipped: subscription.expected !== undefined,
		},
	};
}

function summarizeCodex(
	id: string,
	subscription: Extract<SubscriptionConfig, { provider: "codex" }>,
	auth: z.output<typeof CodexAuthSchema>,
): Summary {
	const hasApiKey =
		typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim().length > 0;
	const tokens = auth.tokens;
	const hasTokens =
		typeof tokens?.id_token === "string" &&
		typeof tokens.access_token === "string" &&
		typeof tokens.refresh_token === "string" &&
		typeof tokens.account_id === "string";
	const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : null;
	const baseMetadata: Record<string, MetadataValue> = {
		hasApiKey,
		hasTokens,
		accountId,
		authMode: auth.auth_mode ?? null,
		lastRefresh: auth.last_refresh ?? null,
	};
	if (typeof tokens?.id_token === "string") {
		Object.assign(baseMetadata, codexJwtMetadata(tokens.id_token));
	}

	if (subscription.mode === "apikey") {
		if (!hasApiKey) {
			return {
				id,
				provider: subscription.provider,
				mode: subscription.mode,
				sourceDir: subscription.sourceDir,
				valid: false,
				reason: "missing OPENAI_API_KEY for apikey mode",
				metadata: baseMetadata,
			};
		}
		return {
			id,
			provider: subscription.provider,
			mode: subscription.mode,
			sourceDir: subscription.sourceDir,
			valid: true,
			reason: null,
			metadata: baseMetadata,
		};
	}

	if (!hasTokens) {
		return {
			id,
			provider: subscription.provider,
			mode: subscription.mode,
			sourceDir: subscription.sourceDir,
			valid: false,
			reason: "missing token bundle for chatgpt mode",
			metadata: baseMetadata,
		};
	}
	if (typeof auth.last_refresh !== "string" || auth.last_refresh.trim().length === 0) {
		return {
			id,
			provider: subscription.provider,
			mode: subscription.mode,
			sourceDir: subscription.sourceDir,
			valid: false,
			reason: "missing last_refresh for chatgpt mode",
			metadata: baseMetadata,
		};
	}
	if (
		subscription.workspaceId &&
		accountId !== null &&
		subscription.workspaceId.trim().length > 0 &&
		subscription.workspaceId !== accountId
	) {
		return {
			id,
			provider: subscription.provider,
			mode: subscription.mode,
			sourceDir: subscription.sourceDir,
			valid: false,
			reason: `workspaceId mismatch (expected ${subscription.workspaceId})`,
			metadata: baseMetadata,
		};
	}

	return {
		id,
		provider: subscription.provider,
		mode: subscription.mode,
		sourceDir: subscription.sourceDir,
		valid: true,
		reason: null,
		metadata: baseMetadata,
	};
}

export async function summarizeSubscription(
	id: string,
	subscription: SubscriptionConfig,
): Promise<Summary> {
	if (subscription.provider === "claude-code") {
		if (typeof subscription.sourceDir === "string" && subscription.sourceDir.trim().length > 0) {
			const credPath = join(subscription.sourceDir, ".credentials.json");
			const raw = await readJson(credPath);
			if (raw === null) {
				return {
					id,
					provider: subscription.provider,
					mode: subscription.mode,
					sourceDir: subscription.sourceDir,
					valid: false,
					reason: "missing or unreadable .credentials.json",
					metadata: {},
				};
			}
			const parsed = ClaudeCredentialsSchema.safeParse(raw);
			if (!parsed.success) {
				return {
					id,
					provider: subscription.provider,
					mode: subscription.mode,
					sourceDir: subscription.sourceDir,
					valid: false,
					reason: "invalid .credentials.json shape",
					metadata: {},
				};
			}
			return summarizeClaude(id, subscription, parsed.data);
		}

		if (typeof subscription.tokenFile === "string" && subscription.tokenFile.trim().length > 0) {
			return summarizeClaudeTokenFile(id, subscription, subscription.tokenFile);
		}

		return {
			id,
			provider: subscription.provider,
			mode: subscription.mode,
			sourceDir: "(missing)",
			valid: false,
			reason: "missing sourceDir/tokenFile for claude subscription",
			metadata: {},
		};
	}

	const authPath = join(subscription.sourceDir, "auth.json");
	const raw = await readJson(authPath);
	if (raw === null) {
		return {
			id,
			provider: subscription.provider,
			mode: subscription.mode,
			sourceDir: subscription.sourceDir,
			valid: false,
			reason: "missing or unreadable auth.json",
			metadata: {},
		};
	}
	const parsed = CodexAuthSchema.safeParse(raw);
	if (!parsed.success) {
		return {
			id,
			provider: subscription.provider,
			mode: subscription.mode,
			sourceDir: subscription.sourceDir,
			valid: false,
			reason: "invalid auth.json shape",
			metadata: {},
		};
	}
	return summarizeCodex(id, subscription, parsed.data);
}

export type SubscriptionSummary = Awaited<ReturnType<typeof summarizeSubscription>>;
