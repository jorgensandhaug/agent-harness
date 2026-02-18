export const ALLOWED_PROVIDERS = ["codex"] as const;

const allowedProviders = new Set<string>(ALLOWED_PROVIDERS);

export function isProviderAllowed(provider: string): boolean {
	return allowedProviders.has(provider);
}

export function unsupportedProviderMessage(): string {
	if (ALLOWED_PROVIDERS.length === 1) {
		const onlyProvider = ALLOWED_PROVIDERS[0];
		return `Only the ${onlyProvider} provider is currently supported. Please use provider: "${onlyProvider}".`;
	}

	const providers = ALLOWED_PROVIDERS.map((provider) => `"${provider}"`).join(", ");
	return `Only the following providers are currently supported: ${providers}.`;
}
