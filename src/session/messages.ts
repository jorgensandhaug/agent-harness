import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { StatusChangeSource } from "../events/types.ts";
import type { Agent } from "./types.ts";

export type AgentMessageRole = "user" | "assistant" | "system" | "developer";
export type MessageRoleFilter = "all" | AgentMessageRole;

export type AgentMessage = {
	id: string | null;
	ts: string | null;
	role: AgentMessageRole;
	text: string;
	finishReason: string | null;
	sourceRecord: string;
};

export type ReadAgentMessagesOptions = {
	limit?: number;
	role?: MessageRoleFilter;
};

export type AgentMessagesResult = {
	provider: string;
	source: StatusChangeSource | "internals_unavailable";
	messages: readonly AgentMessage[];
	lastAssistantMessage: AgentMessage | null;
	totalMessages: number;
	truncated: boolean;
	parseErrorCount: number;
	warnings: readonly string[];
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

type ProviderReadResult = {
	source: StatusChangeSource | "internals_unavailable";
	messages: AgentMessage[];
	parseErrorCount: number;
	warnings: string[];
};

type CodexSessionRecord = {
	timestamp?: unknown;
	type?: unknown;
	payload?: {
		type?: unknown;
		message?: unknown;
		role?: unknown;
		content?: unknown;
	} | null;
};

type CodexHistoryRecord = {
	session_id?: unknown;
	ts?: unknown;
};

type ClaudeSessionRecord = {
	timestamp?: unknown;
	type?: unknown;
	message?: {
		role?: unknown;
		content?: unknown;
		stop_reason?: unknown;
	} | null;
};

type PiSessionRecord = {
	timestamp?: unknown;
	type?: unknown;
	message?: {
		role?: unknown;
		content?: unknown;
		stopReason?: unknown;
	} | null;
};

type OpenCodeSessionRecord = {
	id?: unknown;
};

type OpenCodeMessageRecord = {
	id?: unknown;
	role?: unknown;
	finish?: unknown;
	summary?: {
		title?: unknown;
	} | null;
	time?: {
		created?: unknown;
	} | null;
};

type OpenCodePartRecord = {
	type?: unknown;
	text?: unknown;
};

function normalizeLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	const bounded = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit ?? DEFAULT_LIMIT)));
	return bounded;
}

function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const chunks = value
			.map((entry) => {
				if (typeof entry === "string") return entry;
				if (!entry || typeof entry !== "object") return "";
				const asRecord = entry as Record<string, unknown>;
				// biome-ignore lint/complexity/useLiteralKeys: bracket notation required by TS noPropertyAccessFromIndexSignature
				if (typeof asRecord["text"] === "string") return asRecord["text"];
				// biome-ignore lint/complexity/useLiteralKeys: bracket notation required by TS noPropertyAccessFromIndexSignature
				if (typeof asRecord["message"] === "string") return asRecord["message"];
				return "";
			})
			.filter((text) => text.trim().length > 0);
		return chunks.join("\n").trim();
	}
	if (value && typeof value === "object") {
		const asRecord = value as Record<string, unknown>;
		// biome-ignore lint/complexity/useLiteralKeys: bracket notation required by TS noPropertyAccessFromIndexSignature
		if (typeof asRecord["text"] === "string") return asRecord["text"];
		// biome-ignore lint/complexity/useLiteralKeys: bracket notation required by TS noPropertyAccessFromIndexSignature
		if (typeof asRecord["message"] === "string") return asRecord["message"];
		// biome-ignore lint/complexity/useLiteralKeys: bracket notation required by TS noPropertyAccessFromIndexSignature
		if ("content" in asRecord) return extractText(asRecord["content"]);
	}
	return "";
}

function normalizeRole(value: unknown): AgentMessageRole | null {
	if (value !== "user" && value !== "assistant" && value !== "system" && value !== "developer") {
		return null;
	}
	return value;
}

function normalizeIsoTimestamp(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isoFromMs(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return new Date(value).toISOString();
}

function looksLikeClaudeCommandMeta(text: string): boolean {
	const trimmed = text.trim();
	return (
		trimmed.startsWith("<local-command-caveat>") ||
		trimmed.startsWith("<local-command-stdout>") ||
		trimmed.startsWith("<command-name>/")
	);
}

async function newestEntryName(path: string): Promise<string | null> {
	const entries = await readdir(path, { withFileTypes: true });
	const names = entries
		.filter((entry) => entry.isDirectory() || entry.isFile())
		.map((entry) => entry.name)
		.sort()
		.reverse();
	return names[0] ?? null;
}

async function newestCodexSessionFile(sessionsRoot: string): Promise<string | null> {
	try {
		const year = await newestEntryName(sessionsRoot);
		if (!year) return null;
		const month = await newestEntryName(join(sessionsRoot, year));
		if (!month) return null;
		const day = await newestEntryName(join(sessionsRoot, year, month));
		if (!day) return null;

		const dayPath = join(sessionsRoot, year, month, day);
		const entries = await readdir(dayPath, { withFileTypes: true });
		const file = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => entry.name)
			.sort()
			.reverse()[0];
		if (!file) return null;
		return join(dayPath, file);
	} catch {
		return null;
	}
}

async function sessionFileForCodexSessionId(
	sessionsRoot: string,
	sessionId: string,
): Promise<string | null> {
	try {
		const years = (await readdir(sessionsRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort()
			.reverse();

		for (const year of years) {
			const yearPath = join(sessionsRoot, year);
			const months = (await readdir(yearPath, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort()
				.reverse();
			for (const month of months) {
				const monthPath = join(yearPath, month);
				const days = (await readdir(monthPath, { withFileTypes: true }))
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name)
					.sort()
					.reverse();
				for (const day of days) {
					const dayPath = join(monthPath, day);
					const files = (await readdir(dayPath, { withFileTypes: true }))
						.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
						.map((entry) => entry.name)
						.sort()
						.reverse();
					const match = files.find((name) => name.endsWith(`-${sessionId}.jsonl`));
					if (match) {
						return join(dayPath, match);
					}
				}
			}
		}
	} catch {
		return null;
	}
	return null;
}

async function latestCodexHistorySessionId(runtimeDir: string): Promise<string | null> {
	const historyPath = join(runtimeDir, "history.jsonl");
	let text = "";
	try {
		text = await Bun.file(historyPath).text();
	} catch {
		return null;
	}

	let latestSessionId: string | null = null;
	let latestTs = Number.NEGATIVE_INFINITY;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as CodexHistoryRecord;
			const rawSessionId = parsed.session_id;
			if (typeof rawSessionId !== "string") continue;
			const sessionId = rawSessionId.trim();
			if (sessionId.length === 0) continue;
			const ts = typeof parsed.ts === "number" && Number.isFinite(parsed.ts) ? parsed.ts : null;
			if (ts === null) {
				if (latestTs === Number.NEGATIVE_INFINITY) {
					latestSessionId = sessionId;
				}
				continue;
			}
			if (ts >= latestTs) {
				latestTs = ts;
				latestSessionId = sessionId;
			}
		} catch {
			// Ignore malformed history lines.
		}
	}
	return latestSessionId;
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

async function newestOpenCodeSessionFile(sessionRoot: string): Promise<string | null> {
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

async function readCodexMessages(runtimeDir: string): Promise<ProviderReadResult> {
	const sessionsRoot = join(runtimeDir, "sessions");
	const preferredSessionId = await latestCodexHistorySessionId(runtimeDir);
	const warnings: string[] = [];
	let file: string | null = null;
	if (preferredSessionId) {
		file = await sessionFileForCodexSessionId(sessionsRoot, preferredSessionId);
		if (!file) {
			warnings.push(
				`codex history session '${preferredSessionId}' not found in sessions; using newest rollout file`,
			);
		}
	}
	if (!file) {
		file = await newestCodexSessionFile(sessionsRoot);
	}
	if (!file) {
		return {
			source: "internals_unavailable",
			messages: [],
			parseErrorCount: 0,
			warnings: [`codex session file not found under ${sessionsRoot}`],
		};
	}

	const text = await Bun.file(file).text();
	const lines = text.split("\n");
	const eventMessages: AgentMessage[] = [];
	const responseMessages: AgentMessage[] = [];
	let parseErrorCount = 0;

	for (const line of lines) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as CodexSessionRecord;
			const type = typeof parsed.type === "string" ? parsed.type : null;
			if (type === "event_msg") {
				const payloadType = typeof parsed.payload?.type === "string" ? parsed.payload.type : null;
				if (payloadType === "user_message" || payloadType === "agent_message") {
					const role = payloadType === "user_message" ? "user" : "assistant";
					const message = typeof parsed.payload?.message === "string" ? parsed.payload.message : "";
					eventMessages.push({
						id: null,
						ts: normalizeIsoTimestamp(parsed.timestamp),
						role,
						text: message,
						finishReason: null,
						sourceRecord: `event_msg:${payloadType}`,
					});
				}
				continue;
			}

			if (type === "response_item") {
				const payloadType = typeof parsed.payload?.type === "string" ? parsed.payload.type : null;
				const role = normalizeRole(parsed.payload?.role);
				if (payloadType !== "message" || !role) continue;
				const textContent = extractText(parsed.payload?.content);
				responseMessages.push({
					id: null,
					ts: normalizeIsoTimestamp(parsed.timestamp),
					role,
					text: textContent,
					finishReason: null,
					sourceRecord: "response_item:message",
				});
			}
		} catch {
			parseErrorCount++;
		}
	}

	const responseHasAssistant = responseMessages.some(
		(message) => message.role === "assistant" && message.text.trim().length > 0,
	);
	if (responseHasAssistant) {
		return {
			source: "internals_codex_jsonl",
			messages: responseMessages,
			parseErrorCount,
			warnings:
				eventMessages.length > 0
					? [
							...warnings,
							"codex response_item assistant messages preferred over event_msg records to avoid partial chunks",
					  ]
					: warnings,
		};
	}

	if (eventMessages.length > 0) {
		return {
			source: "internals_codex_jsonl",
			messages: eventMessages,
			parseErrorCount,
			warnings,
		};
	}

	return {
		source: "internals_codex_jsonl",
		messages: responseMessages,
		parseErrorCount,
		warnings: [
			...warnings,
			"codex event_msg user/agent messages missing; fell back to response_item messages",
		],
	};
}

async function readClaudeMessages(sessionFilePath: string): Promise<ProviderReadResult> {
	let text = "";
	try {
		text = await Bun.file(sessionFilePath).text();
	} catch {
		return {
			source: "internals_unavailable",
			messages: [],
			parseErrorCount: 0,
			warnings: [`claude session file not readable: ${sessionFilePath}`],
		};
	}

	const lines = text.split("\n");
	const messages: AgentMessage[] = [];
	let parseErrorCount = 0;

	for (const line of lines) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as ClaudeSessionRecord;
			if (parsed.type !== "user" && parsed.type !== "assistant") continue;

			const role = normalizeRole(parsed.message?.role) ?? parsed.type;
			const textContent = extractText(parsed.message?.content);
			if (role === "user" && looksLikeClaudeCommandMeta(textContent)) continue;
			const finishReason =
				typeof parsed.message?.stop_reason === "string" ? parsed.message.stop_reason : null;

			messages.push({
				id: null,
				ts: normalizeIsoTimestamp(parsed.timestamp),
				role,
				text: textContent,
				finishReason,
				sourceRecord: `claude:${parsed.type}`,
			});
		} catch {
			parseErrorCount++;
		}
	}

	return {
		source: "internals_claude_jsonl",
		messages,
		parseErrorCount,
		warnings: [],
	};
}

async function readPiMessages(runtimeDir: string): Promise<ProviderReadResult> {
	const sessionsRoot = join(runtimeDir, "sessions");
	const file = await newestPiSessionFile(sessionsRoot);
	if (!file) {
		return {
			source: "internals_unavailable",
			messages: [],
			parseErrorCount: 0,
			warnings: [`pi session file not found under ${sessionsRoot}`],
		};
	}

	const text = await Bun.file(file).text();
	const lines = text.split("\n");
	const messages: AgentMessage[] = [];
	let parseErrorCount = 0;

	for (const line of lines) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as PiSessionRecord;
			if (parsed.type !== "message") continue;

			const role = normalizeRole(parsed.message?.role);
			if (!role) continue;
			const finishReason =
				typeof parsed.message?.stopReason === "string" ? parsed.message.stopReason : null;

			messages.push({
				id: null,
				ts: normalizeIsoTimestamp(parsed.timestamp),
				role,
				text: extractText(parsed.message?.content),
				finishReason,
				sourceRecord: "pi:message",
			});
		} catch {
			parseErrorCount++;
		}
	}

	return {
		source: "internals_pi_jsonl",
		messages,
		parseErrorCount,
		warnings: [],
	};
}

async function readOpenCodeMessageText(
	storageRoot: string,
	messageId: string,
	fallbackTitle: unknown,
): Promise<{ text: string; parseErrorCount: number }> {
	const partDir = join(storageRoot, "part", messageId);
	let parseErrorCount = 0;

	try {
		const parts = await readdir(partDir, { withFileTypes: true });
		const files = parts
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => entry.name)
			.sort();
		const texts: string[] = [];
		for (const file of files) {
			try {
				const parsed = (await Bun.file(join(partDir, file)).json()) as OpenCodePartRecord;
				if (parsed.type !== "text") continue;
				if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
					texts.push(parsed.text);
				}
			} catch {
				parseErrorCount++;
			}
		}
		if (texts.length > 0) {
			return { text: texts.join("\n").trim(), parseErrorCount };
		}
	} catch {
		// Keep fallback behavior below.
	}

	const summaryTitle = typeof fallbackTitle === "string" ? fallbackTitle : "";
	return { text: summaryTitle.trim(), parseErrorCount };
}

async function readOpenCodeMessages(dataHome: string): Promise<ProviderReadResult> {
	const storageRoot = join(dataHome, "opencode", "storage");
	const sessionRoot = join(storageRoot, "session");
	const sessionFile = await newestOpenCodeSessionFile(sessionRoot);
	if (!sessionFile) {
		return {
			source: "internals_unavailable",
			messages: [],
			parseErrorCount: 0,
			warnings: [`opencode session file not found under ${sessionRoot}`],
		};
	}

	let parseErrorCount = 0;
	let sessionId: string | null = null;
	try {
		const session = (await Bun.file(sessionFile).json()) as OpenCodeSessionRecord;
		sessionId = typeof session.id === "string" ? session.id : null;
	} catch {
		parseErrorCount++;
	}

	if (!sessionId) {
		return {
			source: "internals_unavailable",
			messages: [],
			parseErrorCount,
			warnings: [`opencode session file missing id: ${sessionFile}`],
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
			.map((entry) => entry.name)
			.sort();
	} catch {
		messageFiles = [];
	}

	const messagesWithOrder: Array<{ created: number; message: AgentMessage }> = [];
	for (const file of messageFiles) {
		try {
			const parsed = (await Bun.file(join(messageRoot, file)).json()) as OpenCodeMessageRecord;
			const role = normalizeRole(parsed.role);
			if (!role) continue;

			const id = typeof parsed.id === "string" ? parsed.id : null;
			const created = typeof parsed.time?.created === "number" ? parsed.time.created : 0;
			const { text, parseErrorCount: partParseErrors } = await readOpenCodeMessageText(
				storageRoot,
				id ?? "",
				parsed.summary?.title,
			);
			parseErrorCount += partParseErrors;
			const finishReason = typeof parsed.finish === "string" ? parsed.finish : null;

			messagesWithOrder.push({
				created,
				message: {
					id,
					ts: isoFromMs(parsed.time?.created),
					role,
					text,
					finishReason,
					sourceRecord: "opencode:message",
				},
			});
		} catch {
			parseErrorCount++;
		}
	}

	messagesWithOrder.sort((a, b) => a.created - b.created);
	return {
		source: "internals_opencode_storage",
		messages: messagesWithOrder.map((entry) => entry.message),
		parseErrorCount,
		warnings: [],
	};
}

function roleMatches(role: AgentMessageRole, filter: MessageRoleFilter): boolean {
	if (filter === "all") return true;
	return role === filter;
}

function pickLastAssistant(messages: readonly AgentMessage[]): AgentMessage | null {
	let fallback: AgentMessage | null = null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message) continue;
		if (message.role !== "assistant") continue;
		if (!fallback) fallback = message;
		if (message.text.trim().length > 0) return message;
	}
	return fallback;
}

export async function readAgentMessages(
	agent: Agent,
	options: ReadAgentMessagesOptions = {},
): Promise<AgentMessagesResult> {
	const roleFilter = options.role ?? "all";
	const limit = normalizeLimit(options.limit);
	let providerRead: ProviderReadResult = {
		source: "internals_unavailable",
		messages: [],
		parseErrorCount: 0,
		warnings: [`provider '${agent.provider}' is not supported for internals messages`],
	};

	if (agent.provider === "codex") {
		if (!agent.providerRuntimeDir) {
			providerRead = {
				source: "internals_unavailable",
				messages: [],
				parseErrorCount: 0,
				warnings: ["codex runtime dir missing on agent metadata"],
			};
		} else {
			providerRead = await readCodexMessages(agent.providerRuntimeDir);
		}
	} else if (agent.provider === "claude-code") {
		if (!agent.providerSessionFile) {
			providerRead = {
				source: "internals_unavailable",
				messages: [],
				parseErrorCount: 0,
				warnings: ["claude session file missing on agent metadata"],
			};
		} else {
			providerRead = await readClaudeMessages(agent.providerSessionFile);
		}
	} else if (agent.provider === "pi") {
		if (!agent.providerRuntimeDir) {
			providerRead = {
				source: "internals_unavailable",
				messages: [],
				parseErrorCount: 0,
				warnings: ["pi runtime dir missing on agent metadata"],
			};
		} else {
			providerRead = await readPiMessages(agent.providerRuntimeDir);
		}
	} else if (agent.provider === "opencode") {
		if (!agent.providerRuntimeDir) {
			providerRead = {
				source: "internals_unavailable",
				messages: [],
				parseErrorCount: 0,
				warnings: ["opencode runtime dir missing on agent metadata"],
			};
		} else {
			providerRead = await readOpenCodeMessages(agent.providerRuntimeDir);
		}
	}

	const roleFiltered = providerRead.messages.filter((message) =>
		roleMatches(message.role, roleFilter),
	);
	const totalMessages = roleFiltered.length;
	const startIndex = Math.max(0, totalMessages - limit);
	const messages = roleFiltered.slice(startIndex);

	return {
		provider: agent.provider,
		source: providerRead.source,
		messages,
		lastAssistantMessage: pickLastAssistant(providerRead.messages),
		totalMessages,
		truncated: startIndex > 0,
		parseErrorCount: providerRead.parseErrorCount,
		warnings: providerRead.warnings,
	};
}
