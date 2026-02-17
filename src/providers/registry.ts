import { type Result, err, ok } from "../types.ts";
import { claudeCodeProvider } from "./claude-code.ts";
import { codexProvider } from "./codex.ts";
import { opencodeProvider } from "./opencode.ts";
import { piProvider } from "./pi.ts";
import type { Provider } from "./types.ts";

type UnknownProviderError = { code: "UNKNOWN_PROVIDER"; name: string };

const providers = new Map<string, Provider>();

// Register all built-in providers
providers.set(claudeCodeProvider.name, claudeCodeProvider);
providers.set(codexProvider.name, codexProvider);
providers.set(piProvider.name, piProvider);
providers.set(opencodeProvider.name, opencodeProvider);

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
