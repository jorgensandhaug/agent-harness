import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentStatus } from "../providers/types.ts";

export type CodexInternalsCursor = {
	sessionFile: string | null;
	offset: number;
	partialLine: string;
	lastStatus: AgentStatus | null;
};

export type CodexInternalsResult = {
	cursor: CodexInternalsCursor;
	status: AgentStatus | null;
	parseErrorCount: number;
};

type SessionRecord = {
	type?: unknown;
	payload?: unknown;
};

type ResponseItemPayload = {
	type?: unknown;
	role?: unknown;
	phase?: unknown;
};

type EventMessagePayload = {
	type?: unknown;
};

export function newCodexInternalsCursor(): CodexInternalsCursor {
	return {
		sessionFile: null,
		offset: 0,
		partialLine: "",
		lastStatus: null,
	};
}

async function sessionFilesOldestFirst(sessionsRoot: string): Promise<string[]> {
	const files: string[] = [];
	const years = await readdir(sessionsRoot, { withFileTypes: true });
	const sortedYears = years
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();

	for (const year of sortedYears) {
		const yearPath = join(sessionsRoot, year);
		const months = await readdir(yearPath, { withFileTypes: true });
		const sortedMonths = months
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();

		for (const month of sortedMonths) {
			const monthPath = join(yearPath, month);
			const days = await readdir(monthPath, { withFileTypes: true });
			const sortedDays = days
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();

			for (const day of sortedDays) {
				const dayPath = join(monthPath, day);
				const entries = await readdir(dayPath, { withFileTypes: true });
				const dayFiles = entries
					.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
					.map((entry) => join(dayPath, entry.name))
					.sort();
				files.push(...dayFiles);
			}
		}
	}

	return files;
}

async function firstSessionFile(sessionsRoot: string): Promise<string | null> {
	try {
		const files = await sessionFilesOldestFirst(sessionsRoot);
		return files[0] ?? null;
	} catch {
		return null;
	}
}

function statusFromEvent(record: SessionRecord): AgentStatus | null {
	const type = typeof record.type === "string" ? record.type : null;
	if (!type) return null;

	if (type === "error") return "error";
	if (type === "response_item") {
		const payload = (record.payload ?? {}) as ResponseItemPayload;
		const payloadType = typeof payload.type === "string" ? payload.type : null;
		if (payloadType === "message") {
			const role = typeof payload.role === "string" ? payload.role : null;
			const phase = typeof payload.phase === "string" ? payload.phase : null;
			if (role === "assistant" && phase === "final_answer") return "idle";
		}
		if (
			payloadType === "reasoning" ||
			payloadType === "function_call" ||
			payloadType === "custom_tool_call"
		) {
			return "processing";
		}
		return null;
	}
	if (type !== "event_msg") return null;

	const payload = (record.payload ?? {}) as EventMessagePayload;
	const payloadType = typeof payload.type === "string" ? payload.type : null;
	if (!payloadType) return null;

	if (payloadType === "task_started") return "processing";
	if (payloadType === "task_complete") return "idle";
	if (payloadType === "turn_aborted") return "idle";
	if (payloadType === "agent_reasoning" || payloadType === "agent_message") return "processing";
	return null;
}

export async function readCodexInternalsStatus(
	codexRuntimeDir: string,
	cursor: CodexInternalsCursor,
): Promise<CodexInternalsResult> {
	const sessionsRoot = join(codexRuntimeDir, "sessions");
	const file = cursor.sessionFile ?? (await firstSessionFile(sessionsRoot));
	if (!file) {
		return { cursor, status: cursor.lastStatus, parseErrorCount: 0 };
	}

	let nextCursor =
		cursor.sessionFile === file
			? cursor
			: {
					sessionFile: file,
					offset: 0,
					partialLine: "",
					lastStatus: cursor.lastStatus,
				};
	let fullText = "";
	try {
		fullText = await Bun.file(file).text();
	} catch {
		return { cursor: nextCursor, status: nextCursor.lastStatus, parseErrorCount: 0 };
	}
	const safeOffset =
		nextCursor.offset >= 0 && nextCursor.offset <= fullText.length ? nextCursor.offset : 0;
	const appendedText = fullText.slice(safeOffset);
	const combined = `${nextCursor.partialLine}${appendedText}`;
	const lines = combined.split("\n");
	const partialLine = lines.pop() ?? "";

	let parseErrorCount = 0;
	let status = nextCursor.lastStatus;
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as SessionRecord;
			const derived = statusFromEvent(parsed);
			if (derived) status = derived;
		} catch {
			parseErrorCount++;
		}
	}

	nextCursor = {
		sessionFile: file,
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
