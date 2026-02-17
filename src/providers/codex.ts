import type { AgentStatus, Provider, ProviderConfig, ProviderEvent } from "./types.ts";

/**
 * Codex CLI provider. Interactive mode patterns are empirically untested
 * (flagged unknown #1 in wave2 plan). Using best-effort patterns based on
 * typical readline-style CLI prompts.
 */

const IDLE_PATTERN = /^[>❯]\s*$/m;
const PROCESSING_PATTERN = /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|thinking|working/i;
const PERMISSION_PATTERN = /\b(allow|approve|deny|y\/n|yes\/no)\b.*[?:]\s*$/im;
const ERROR_PATTERN = /\bError\b|\bERROR\b|\bfailed\b|\bFailed\b/;
const EXITED_PATTERN = /\$\s*$/m;

export const codexProvider: Provider = {
	name: "codex",

	buildCommand(config: ProviderConfig): readonly string[] {
		const cmd = [config.command];
		if (config.model) {
			cmd.push("--model", config.model);
		}
		cmd.push(...config.extraArgs);
		return cmd;
	},

	buildEnv(config: ProviderConfig): Record<string, string> {
		return { ...config.env };
	},

	parseStatus(capturedOutput: string): AgentStatus {
		const lines = capturedOutput.split("\n");
		const tail = lines.slice(-20).join("\n");

		if (EXITED_PATTERN.test(tail) && !IDLE_PATTERN.test(tail) && !PROCESSING_PATTERN.test(tail)) {
			return "exited";
		}
		if (PERMISSION_PATTERN.test(tail)) {
			return "waiting_input";
		}
		const lastFew = lines.slice(-5).join("\n");
		if (ERROR_PATTERN.test(lastFew) && !PROCESSING_PATTERN.test(tail)) {
			return "error";
		}
		if (PROCESSING_PATTERN.test(tail)) {
			return "processing";
		}
		if (IDLE_PATTERN.test(tail)) {
			return "idle";
		}
		return "starting";
	},

	idlePattern(): RegExp {
		return IDLE_PATTERN;
	},

	formatInput(message: string): string {
		return message;
	},

	exitCommand(): string {
		return "exit";
	},

	parseOutputDiff(diff: string): readonly ProviderEvent[] {
		const events: ProviderEvent[] = [];
		for (const line of diff.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			if (IDLE_PATTERN.test(line) || PROCESSING_PATTERN.test(line)) continue;

			if (PERMISSION_PATTERN.test(line)) {
				events.push({ kind: "permission_requested", description: trimmed });
			} else if (ERROR_PATTERN.test(line)) {
				events.push({ kind: "error", message: trimmed });
			} else if (/[a-zA-Z0-9]/.test(trimmed)) {
				events.push({ kind: "text", content: trimmed });
			} else {
				events.push({ kind: "unknown", raw: trimmed });
			}
		}
		return events;
	},
};
