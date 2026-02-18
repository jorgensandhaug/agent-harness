import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentStatus } from "../providers/types.ts";

export type PiInternalsCursor = {
	sessionFile: string | null;
	offset: number;
	partialLine: string;
	lastStatus: AgentStatus | null;
};

export type PiInternalsResult = {
	cursor: PiInternalsCursor;
	status: AgentStatus | null;
	parseErrorCount: number;
};

type PiRecord = {
	type?: unknown;
	message?: {
		role?: unknown;
		stopReason?: unknown;
	} | null;
};

export function newPiInternalsCursor(): PiInternalsCursor {
	return {
		sessionFile: null,
		offset: 0,
		partialLine: "",
		lastStatus: null,
	};
}

async function newestPiSessionFile(sessionsRoot: string): Promise<string | null> {
	try {
		const directories = await readdir(sessionsRoot, { withFileTypes: true });
		let newestName: string | null = null;
		let newestPath: string | null = null;

		for (const directory of directories) {
			if (!directory.isDirectory()) continue;
			const dirPath = join(sessionsRoot, directory.name);
			const files = await readdir(dirPath, { withFileTypes: true });
			const newestInDir = files
				.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
				.map((entry) => entry.name)
				.sort()
				.reverse()[0];
			if (!newestInDir) continue;
			if (!newestName || newestInDir > newestName) {
				newestName = newestInDir;
				newestPath = join(dirPath, newestInDir);
			}
		}

		return newestPath;
	} catch {
		return null;
	}
}

function statusFromRecord(record: PiRecord): AgentStatus | null {
	const type = typeof record.type === "string" ? record.type : null;
	if (type !== "message") return null;

	const role = typeof record.message?.role === "string" ? record.message.role : null;
	if (role === "user") return "processing";
	if (role === "assistant") {
		const stopReason =
			typeof record.message?.stopReason === "string" ? record.message.stopReason : null;
		if (stopReason === "error") return "error";
		return "idle";
	}
	return null;
}

export async function readPiInternalsStatus(
	piRuntimeDir: string,
	cursor: PiInternalsCursor,
): Promise<PiInternalsResult> {
	const sessionsRoot = join(piRuntimeDir, "sessions");
	const file = await newestPiSessionFile(sessionsRoot);
	if (!file) {
		return { cursor, status: cursor.lastStatus, parseErrorCount: 0 };
	}

	let nextCursor = cursor;
	if (cursor.sessionFile !== file) {
		nextCursor = {
			sessionFile: file,
			offset: 0,
			partialLine: "",
			lastStatus: cursor.lastStatus,
		};
	}

	const fullText = await Bun.file(file).text();
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
			const parsed = JSON.parse(line) as PiRecord;
			const derived = statusFromRecord(parsed);
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
