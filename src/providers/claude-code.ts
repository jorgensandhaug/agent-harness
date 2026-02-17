import type { AgentStatus, Provider, ProviderConfig, ProviderEvent } from "./types.ts";

/**
 * Strip ANSI escape codes from a string for pattern matching.
 * Covers CSI sequences, OSC sequences, and other common escape patterns.
 */
function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // CSI sequences
		.replace(/\x1b\][^\x07]*\x07/g, "") // OSC sequences
		.replace(/\x1b[()][AB012]/g, "") // Character set selection
		.replace(/\x1b[\x20-\x2f][\x30-\x7e]/g, "") // 2-char sequences
		.replace(/\u00a0/g, " "); // Non-breaking spaces → regular spaces
}

/** Patterns observed from Claude Code interactive mode (CAO research) */
const IDLE_PATTERN = /^[> ]*>\s*$/m;
const PROCESSING_PATTERN = /✻/;
const PERMISSION_PATTERN =
	/\b(Allow|Approve|Deny|allow|approve|deny|y\/n|Y\/n|yes\/no)\b.*[?:]\s*$/m;
const ERROR_PATTERN = /\bError\b|\bERROR\b|\bfailed\b|\bFailed\b/;
const TOOL_START_PATTERN = /⏺\s+(\w+)(?:\s*\(([^)]*)\))?/;
const TOOL_END_PATTERN = /⏺\s+(\w+)\s+completed/i;
const COMPLETION_PATTERN = /⏺\s+Task completed|I've completed|Done\.|I've finished/;
const EXITED_PATTERN = /\$\s*$/m;

export const claudeCodeProvider: Provider = {
	name: "claude-code",

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
		const clean = stripAnsi(capturedOutput);
		// Check the last ~20 lines for status indicators
		const lines = clean.split("\n");
		const tail = lines.slice(-20).join("\n");

		// Check for exit (shell prompt returned)
		if (EXITED_PATTERN.test(tail) && !IDLE_PATTERN.test(tail) && !PROCESSING_PATTERN.test(tail)) {
			return "exited";
		}

		// Check for permission/confirmation prompts
		if (PERMISSION_PATTERN.test(tail)) {
			return "waiting_input";
		}

		// Check for error state
		const lastFewLines = lines.slice(-5).join("\n");
		if (ERROR_PATTERN.test(lastFewLines) && !PROCESSING_PATTERN.test(tail)) {
			return "error";
		}

		// Check for processing (spinner)
		if (PROCESSING_PATTERN.test(tail)) {
			return "processing";
		}

		// Check for idle (prompt visible)
		if (IDLE_PATTERN.test(tail)) {
			return "idle";
		}

		// Default: still starting or in unknown state
		return "starting";
	},

	idlePattern(): RegExp {
		return IDLE_PATTERN;
	},

	formatInput(message: string): string {
		// Claude Code accepts text pasted at its prompt followed by Enter
		return `${message}\n`;
	},

	exitCommand(): string {
		return "/exit";
	},

	parseOutputDiff(diff: string): readonly ProviderEvent[] {
		const clean = stripAnsi(diff);
		const events: ProviderEvent[] = [];
		const lines = clean.split("\n");

		let i = 0;
		while (i < lines.length) {
			const line = lines[i] ?? "";

			// Check for tool start
			const toolStartMatch = line.match(TOOL_START_PATTERN);
			if (toolStartMatch) {
				events.push({
					kind: "tool_start",
					tool: toolStartMatch[1] ?? "unknown",
					input: toolStartMatch[2] ?? "",
				});
				i++;
				continue;
			}

			// Check for tool end
			const toolEndMatch = line.match(TOOL_END_PATTERN);
			if (toolEndMatch) {
				events.push({
					kind: "tool_end",
					tool: toolEndMatch[1] ?? "unknown",
					output: "",
				});
				i++;
				continue;
			}

			// Check for completion
			if (COMPLETION_PATTERN.test(line)) {
				events.push({
					kind: "completion",
					summary: line.trim(),
				});
				i++;
				continue;
			}

			// Check for errors
			if (ERROR_PATTERN.test(line) && line.trim().length > 0) {
				events.push({
					kind: "error",
					message: line.trim(),
				});
				i++;
				continue;
			}

			// Regular text output — skip empty lines and prompt indicators
			const trimmed = line.trim();
			if (trimmed.length > 0 && !IDLE_PATTERN.test(line) && !PROCESSING_PATTERN.test(line)) {
				events.push({
					kind: "text",
					content: trimmed,
				});
			}

			i++;
		}

		return events;
	},
};
