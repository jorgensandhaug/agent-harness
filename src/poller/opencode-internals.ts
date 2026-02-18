import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentStatus } from "../providers/types.ts";

export type OpenCodeInternalsCursor = {
	sessionFile: string | null;
	lastStatus: AgentStatus | null;
};

export type OpenCodeInternalsResult = {
	cursor: OpenCodeInternalsCursor;
	status: AgentStatus | null;
	parseErrorCount: number;
};

type SessionRecord = {
	id?: unknown;
};

type MessageRecord = {
	id?: unknown;
	role?: unknown;
	finish?: unknown;
	time?: {
		created?: unknown;
		completed?: unknown;
	} | null;
};

type PartRecord = {
	type?: unknown;
	state?: {
		status?: unknown;
	} | null;
};

export function newOpenCodeInternalsCursor(): OpenCodeInternalsCursor {
	return {
		sessionFile: null,
		lastStatus: null,
	};
}

async function newestOpencodeSessionFile(sessionRoot: string): Promise<string | null> {
	try {
		const entries = await readdir(sessionRoot, { withFileTypes: true });
		let newestPath: string | null = null;
		let newestName: string | null = null;

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dirPath = join(sessionRoot, entry.name);
			const files = await readdir(dirPath, { withFileTypes: true });
			const newestInDir = files
				.filter(
					(file) => file.isFile() && file.name.startsWith("ses_") && file.name.endsWith(".json"),
				)
				.map((file) => file.name)
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

function parseCreatedTime(message: MessageRecord): number {
	const created = message.time?.created;
	if (typeof created !== "number" || !Number.isFinite(created)) return 0;
	return created;
}

function statusFromLatestMessage(message: MessageRecord | null): AgentStatus | null {
	if (!message) return null;
	const role = typeof message.role === "string" ? message.role : null;
	if (role === "user") return "processing";
	if (role !== "assistant") return null;

	const finish = typeof message.finish === "string" ? message.finish : null;
	const completed = message.time?.completed;
	const hasCompleted = typeof completed === "number" && Number.isFinite(completed);

	if (finish === "error") return "error";
	if (!hasCompleted) return "processing";
	if (finish && finish !== "stop") return "processing";
	return "idle";
}

async function hasToolError(storageRoot: string, messageId: string): Promise<boolean> {
	try {
		const partDir = join(storageRoot, "part", messageId);
		const partFiles = await readdir(partDir, { withFileTypes: true });
		for (const partFile of partFiles) {
			if (!partFile.isFile() || !partFile.name.endsWith(".json")) continue;
			const parsed = (await Bun.file(join(partDir, partFile.name)).json()) as PartRecord;
			const type = typeof parsed.type === "string" ? parsed.type : null;
			const stateStatus = typeof parsed.state?.status === "string" ? parsed.state.status : null;
			if (type === "tool" && stateStatus === "error") return true;
		}
		return false;
	} catch {
		return false;
	}
}

export async function readOpenCodeInternalsStatus(
	opencodeDataHome: string,
	cursor: OpenCodeInternalsCursor,
): Promise<OpenCodeInternalsResult> {
	const storageRoot = join(opencodeDataHome, "opencode", "storage");
	const sessionRoot = join(storageRoot, "session");
	const sessionFile = await newestOpencodeSessionFile(sessionRoot);
	if (!sessionFile) {
		return { cursor, status: cursor.lastStatus, parseErrorCount: 0 };
	}

	let parseErrorCount = 0;
	let sessionId: string | null = null;
	try {
		const session = (await Bun.file(sessionFile).json()) as SessionRecord;
		sessionId = typeof session.id === "string" ? session.id : null;
	} catch {
		parseErrorCount++;
	}
	if (!sessionId) {
		return {
			cursor: { sessionFile, lastStatus: cursor.lastStatus },
			status: cursor.lastStatus,
			parseErrorCount,
		};
	}

	const messageRoot = join(storageRoot, "message", sessionId);
	let messageFiles: readonly string[] = [];
	try {
		const entries = await readdir(messageRoot, { withFileTypes: true });
		messageFiles = entries
			.filter(
				(entry) => entry.isFile() && entry.name.startsWith("msg_") && entry.name.endsWith(".json"),
			)
			.map((entry) => entry.name);
	} catch {
		messageFiles = [];
	}

	let latest: MessageRecord | null = null;
	let latestId: string | null = null;
	let latestCreated = Number.NEGATIVE_INFINITY;
	for (const messageFile of messageFiles) {
		try {
			const parsed = (await Bun.file(join(messageRoot, messageFile)).json()) as MessageRecord;
			const created = parseCreatedTime(parsed);
			if (created >= latestCreated) {
				latest = parsed;
				latestCreated = created;
				latestId = typeof parsed.id === "string" ? parsed.id : null;
			}
		} catch {
			parseErrorCount++;
		}
	}

	let status = statusFromLatestMessage(latest);
	if (!status) status = cursor.lastStatus;
	if (latestId && (await hasToolError(storageRoot, latestId))) {
		status = "error";
	}

	return {
		cursor: {
			sessionFile,
			lastStatus: status,
		},
		status,
		parseErrorCount,
	};
}
