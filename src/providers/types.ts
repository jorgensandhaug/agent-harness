export type AgentStatus = "starting" | "idle" | "processing" | "waiting_input" | "error" | "exited";

export type ProviderEvent =
	| { kind: "text"; content: string }
	| { kind: "tool_start"; tool: string; input: string }
	| { kind: "tool_end"; tool: string; output: string }
	| { kind: "error"; message: string }
	| { kind: "completion"; summary: string };

export interface ProviderConfig {
	command: string;
	extraArgs: readonly string[];
	env: Record<string, string>;
	model?: string | undefined;
	enabled: boolean;
}

export interface Provider {
	readonly name: string;
	buildCommand(config: ProviderConfig): readonly string[];
	buildEnv(config: ProviderConfig): Record<string, string>;
	parseStatus(capturedOutput: string): AgentStatus;
	idlePattern(): RegExp;
	formatInput(message: string): string;
	exitCommand(): string;
	parseOutputDiff(diff: string): readonly ProviderEvent[];
}
