import type { AgentStatus, ProviderEvent } from "../providers/types.ts";

const PROCESSING_IDLE_TIMEOUT_MS = 3000;
const SHELL_COMMANDS = new Set(["bash", "zsh", "sh", "fish", "nu", "dash", "ksh"]);

export type DeriveStatusInput = {
	currentStatus: AgentStatus;
	parsedStatus: AgentStatus;
	paneDead: boolean;
	paneCurrentCommand: string | null;
	currentOutput: string;
	diff: string;
	providerEvents: readonly ProviderEvent[];
	lastDiffAtMs: number | null;
	nowMs: number;
};

export function isLikelyAgentProcessAlive(paneCurrentCommand: string | null): boolean {
	if (!paneCurrentCommand) return false;
	const normalized = paneCurrentCommand.trim().toLowerCase();
	if (normalized.length === 0) return false;
	return !SHELL_COMMANDS.has(normalized);
}

export function deriveStatusFromSignals(input: DeriveStatusInput): AgentStatus {
	if (input.paneDead) return "exited";

	if (input.parsedStatus !== "starting") return input.parsedStatus;

	const hasDiff = input.diff.trim().length > 0;
	const commandAlive = isLikelyAgentProcessAlive(input.paneCurrentCommand);
	const hasOutput = input.currentOutput.trim().length > 0;

	if (input.providerEvents.some((event) => event.kind === "error")) {
		return "error";
	}
	if (
		input.providerEvents.some(
			(event) => event.kind === "permission_requested" || event.kind === "question_asked",
		)
	) {
		return "waiting_input";
	}
	if (input.providerEvents.some((event) => event.kind === "tool_start")) {
		return "processing";
	}
	if (input.providerEvents.some((event) => event.kind === "completion")) {
		return "idle";
	}

	if (input.currentStatus === "error" || input.currentStatus === "waiting_input") {
		return input.currentStatus;
	}

	if (hasDiff) return "processing";

	if (input.currentStatus === "processing") {
		if (
			commandAlive &&
			input.lastDiffAtMs !== null &&
			input.nowMs - input.lastDiffAtMs >= PROCESSING_IDLE_TIMEOUT_MS
		) {
			return "idle";
		}
		return "processing";
	}

	if (input.currentStatus === "idle") return "idle";

	if (input.currentStatus === "starting" && commandAlive && hasOutput) {
		return "idle";
	}

	return input.currentStatus;
}
