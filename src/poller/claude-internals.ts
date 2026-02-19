import type { AgentStatus } from "../providers/types.ts";
import { claudeSessionFileCandidates } from "../session/claude-path.ts";

export type ClaudeInternalsCursor = {
	offset: number;
	partialLine: string;
	lastStatus: AgentStatus | null;
};

export type ClaudeInternalsResult = {
	cursor: ClaudeInternalsCursor;
	status: AgentStatus | null;
	parseErrorCount: number;
};

type ClaudeRecord = {
	type?: unknown;
	operation?: unknown;
	level?: unknown;
	message?: {
		stop_reason?: unknown;
	} | null;
};

function isTerminalAssistantStopReason(reason: string): boolean {
	return reason === "end_turn" || reason === "max_tokens" || reason === "stop_sequence";
}

export function newClaudeInternalsCursor(): ClaudeInternalsCursor {
	return {
		offset: 0,
		partialLine: "",
		lastStatus: null,
	};
}

function statusFromRecord(record: ClaudeRecord): AgentStatus | null {
	const type = typeof record.type === "string" ? record.type : null;
	if (!type) return null;

	if (type === "queue-operation") {
		const operation = typeof record.operation === "string" ? record.operation : null;
		if (operation === "enqueue") return "processing";
		return null;
	}
	if (type === "user") return "processing";
	if (type === "assistant") {
		const stopReason =
			typeof record.message?.stop_reason === "string" ? record.message.stop_reason : null;
		if (stopReason === "error") return "error";
		if (!stopReason) return "processing";
		if (isTerminalAssistantStopReason(stopReason)) return "idle";
		return "processing";
	}
	if (type === "system") {
		const level = typeof record.level === "string" ? record.level : null;
		if (level === "error") return "error";
	}
	return null;
}

export async function readClaudeInternalsStatus(
	sessionFilePath: string,
	cursor: ClaudeInternalsCursor,
): Promise<ClaudeInternalsResult> {
	let fullText = "";
	const candidates = claudeSessionFileCandidates(sessionFilePath);
	let foundReadable = false;
	for (const candidate of candidates) {
		try {
			fullText = await Bun.file(candidate).text();
			foundReadable = true;
			break;
		} catch {
			// Try next candidate.
		}
	}
	if (!foundReadable) {
		return { cursor, status: cursor.lastStatus, parseErrorCount: 0 };
	}

	const safeOffset = cursor.offset >= 0 && cursor.offset <= fullText.length ? cursor.offset : 0;
	const appendedText = fullText.slice(safeOffset);
	const combined = `${cursor.partialLine}${appendedText}`;
	const lines = combined.split("\n");
	const partialLine = lines.pop() ?? "";

	let parseErrorCount = 0;
	let status = cursor.lastStatus;
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as ClaudeRecord;
			const derived = statusFromRecord(parsed);
			if (derived) status = derived;
		} catch {
			parseErrorCount++;
		}
	}

	const nextCursor: ClaudeInternalsCursor = {
		offset: fullText.length,
		partialLine,
		lastStatus: status,
	};

	return {
		cursor: nextCursor,
		status,
		parseErrorCount,
	};
}
