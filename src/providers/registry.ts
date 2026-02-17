import { type Result, err, ok } from "../types.ts";
import { claudeCodeProvider } from "./claude-code.ts";
import type { Provider } from "./types.ts";

type UnknownProviderError = { code: "UNKNOWN_PROVIDER"; name: string };

const providers = new Map<string, Provider>();

// Register built-in providers
providers.set(claudeCodeProvider.name, claudeCodeProvider);

export function getProvider(name: string): Result<Provider, UnknownProviderError> {
	const provider = providers.get(name);
	if (!provider) {
		return err({ code: "UNKNOWN_PROVIDER", name });
	}
	return ok(provider);
}

export function listProviders(): readonly string[] {
	return Array.from(providers.keys());
}
