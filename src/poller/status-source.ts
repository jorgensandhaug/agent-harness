type PollAgentLike = {
	provider: string;
	providerRuntimeDir?: string;
	providerSessionFile?: string;
};

export function hasInternalsStatusSource(agent: PollAgentLike): boolean {
	if (agent.provider === "claude-code") {
		return (
			typeof agent.providerSessionFile === "string" && agent.providerSessionFile.trim().length > 0
		);
	}
	if (agent.provider === "codex" || agent.provider === "pi" || agent.provider === "opencode") {
		return (
			typeof agent.providerRuntimeDir === "string" && agent.providerRuntimeDir.trim().length > 0
		);
	}
	return false;
}

export function shouldUseUiParserForStatus(agent: PollAgentLike): boolean {
	if (agent.provider === "codex") {
		// Codex status must come from internals only; UI parser/heuristics are too noisy.
		return false;
	}
	return !hasInternalsStatusSource(agent);
}
