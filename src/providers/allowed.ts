export const ALLOWED_PROVIDERS = ["codex", "claude-code"] as const;

const allowedProviders = new Set<string>(ALLOWED_PROVIDERS);

export function isProviderAllowed(provider: string): boolean {
	return allowedProviders.has(provider);
}

export function unsupportedProviderMessage(): string {
	const providers = ALLOWED_PROVIDERS.map((provider) => `"${provider}"`).join(", ");
	return `Only the following providers are currently supported: ${providers}.`;
}
