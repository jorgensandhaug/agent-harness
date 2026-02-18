import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentId, projectName } from "../types.ts";
import { readAgentMessages } from "./messages.ts";
import type { Agent } from "./types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
});

function baseAgent(): Agent {
	const now = new Date().toISOString();
	return {
		id: agentId("a1b2c3d4"),
		project: projectName("p1"),
		provider: "codex",
		status: "idle",
		brief: "idle",
		task: "test",
		windowName: "w1",
		tmuxTarget: "s:w1",
		attachCommand: "tmux attach -t s",
		createdAt: now,
		lastActivity: now,
		lastCapturedOutput: "",
	};
}

describe("session/messages.readAgentMessages", () => {
	it("reads codex user/assistant messages from event_msg records", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-msg-codex-"));
		tempDirs.push(root);
		const dir = join(root, "sessions", "2026", "02", "17");
		await mkdir(dir, { recursive: true });
		const file = join(dir, "rollout-2026-02-17T00-00-00.jsonl");
		await Bun.write(
			file,
			[
				JSON.stringify({
					timestamp: "2026-02-17T00:00:00.000Z",
					type: "event_msg",
					payload: { type: "user_message", message: "hi" },
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:01.000Z",
					type: "event_msg",
					payload: { type: "agent_message", message: "hello" },
				}),
			].join("\n"),
		);

		const agent: Agent = { ...baseAgent(), provider: "codex", providerRuntimeDir: root };
		const result = await readAgentMessages(agent, { role: "all", limit: 10 });

		expect(result.source).toBe("internals_codex_jsonl");
		expect(result.messages.map((m) => [m.role, m.text])).toEqual([
			["user", "hi"],
			["assistant", "hello"],
		]);
		expect(result.lastAssistantMessage?.text).toBe("hello");
	});

	it("returns latest codex assistant message after follow-up turn", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-msg-codex-last-"));
		tempDirs.push(root);
		const dir = join(root, "sessions", "2026", "02", "17");
		await mkdir(dir, { recursive: true });
		await Bun.write(
			join(dir, "rollout-2026-02-17T00-00-00.jsonl"),
			[
				JSON.stringify({
					timestamp: "2026-02-17T00:00:00.000Z",
					type: "event_msg",
					payload: { type: "user_message", message: "first user" },
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:01.000Z",
					type: "event_msg",
					payload: { type: "agent_message", message: "first assistant" },
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:02.000Z",
					type: "event_msg",
					payload: { type: "user_message", message: "second user" },
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:03.000Z",
					type: "event_msg",
					payload: { type: "agent_message", message: "second assistant" },
				}),
			].join("\n"),
		);

		const agent: Agent = { ...baseAgent(), provider: "codex", providerRuntimeDir: root };
		const result = await readAgentMessages(agent, { role: "all", limit: 50 });

		expect(result.messages.map((m) => [m.role, m.text])).toEqual([
			["user", "first user"],
			["assistant", "first assistant"],
			["user", "second user"],
			["assistant", "second assistant"],
		]);
		expect(result.lastAssistantMessage?.text).toBe("second assistant");
	});

	it("reads claude assistant content and skips local command metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-msg-claude-"));
		tempDirs.push(root);
		const file = join(root, "session.jsonl");
		await Bun.write(
			file,
			[
				JSON.stringify({
					timestamp: "2026-02-17T00:00:00.000Z",
					type: "user",
					message: { role: "user", content: "hello" },
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:01.000Z",
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "world" }],
						stop_reason: "end_turn",
					},
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:02.000Z",
					type: "user",
					message: { role: "user", content: "<local-command-caveat>meta</local-command-caveat>" },
				}),
			].join("\n"),
		);

		const agent: Agent = { ...baseAgent(), provider: "claude-code", providerSessionFile: file };
		const result = await readAgentMessages(agent, { role: "all", limit: 10 });

		expect(result.source).toBe("internals_claude_jsonl");
		expect(result.messages.map((m) => [m.role, m.text])).toEqual([
			["user", "hello"],
			["assistant", "world"],
		]);
		expect(result.lastAssistantMessage?.finishReason).toBe("end_turn");
	});

	it("returns latest claude assistant message after follow-up turn", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-msg-claude-last-"));
		tempDirs.push(root);
		const file = join(root, "session.jsonl");
		await Bun.write(
			file,
			[
				JSON.stringify({
					timestamp: "2026-02-17T00:00:00.000Z",
					type: "user",
					message: { role: "user", content: "first user" },
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:01.000Z",
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "first assistant" }],
						stop_reason: "end_turn",
					},
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:02.000Z",
					type: "user",
					message: { role: "user", content: "second user" },
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:03.000Z",
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "second assistant" }],
						stop_reason: "end_turn",
					},
				}),
			].join("\n"),
		);

		const agent: Agent = { ...baseAgent(), provider: "claude-code", providerSessionFile: file };
		const result = await readAgentMessages(agent, { role: "all", limit: 50 });

		expect(result.messages.map((m) => [m.role, m.text])).toEqual([
			["user", "first user"],
			["assistant", "first assistant"],
			["user", "second user"],
			["assistant", "second assistant"],
		]);
		expect(result.lastAssistantMessage?.text).toBe("second assistant");
	});

	it("reads pi message history and last assistant text", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-msg-pi-"));
		tempDirs.push(root);
		const dir = join(root, "sessions", "p");
		await mkdir(dir, { recursive: true });
		const file = join(dir, "2026-02-17T00-00-00.jsonl");
		await Bun.write(
			file,
			[
				JSON.stringify({
					timestamp: "2026-02-17T00:00:00.000Z",
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "ask" }] },
				}),
				JSON.stringify({
					timestamp: "2026-02-17T00:00:01.000Z",
					type: "message",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "answer" }],
					},
				}),
			].join("\n"),
		);

		const agent: Agent = { ...baseAgent(), provider: "pi", providerRuntimeDir: root };
		const result = await readAgentMessages(agent, { role: "all", limit: 10 });

		expect(result.source).toBe("internals_pi_jsonl");
		expect(result.messages.map((m) => [m.role, m.text])).toEqual([
			["user", "ask"],
			["assistant", "answer"],
		]);
		expect(result.lastAssistantMessage?.text).toBe("answer");
	});

	it("reads opencode messages from storage message/part records", async () => {
		const dataHome = await mkdtemp(join(tmpdir(), "ah-msg-opencode-"));
		tempDirs.push(dataHome);
		const storage = join(dataHome, "opencode", "storage");
		const projectId = "proj1";
		const sessionId = "ses_1";
		const userId = "msg_u1";
		const assistantId = "msg_a1";

		await mkdir(join(storage, "session", projectId), { recursive: true });
		await mkdir(join(storage, "message", sessionId), { recursive: true });
		await mkdir(join(storage, "part", userId), { recursive: true });
		await mkdir(join(storage, "part", assistantId), { recursive: true });

		await Bun.write(
			join(storage, "session", projectId, `${sessionId}.json`),
			JSON.stringify({ id: sessionId, projectID: projectId }),
		);
		await Bun.write(
			join(storage, "message", sessionId, `${userId}.json`),
			JSON.stringify({
				id: userId,
				sessionID: sessionId,
				role: "user",
				time: { created: 1000 },
				summary: { title: "fallback user title" },
			}),
		);
		await Bun.write(
			join(storage, "message", sessionId, `${assistantId}.json`),
			JSON.stringify({
				id: assistantId,
				sessionID: sessionId,
				role: "assistant",
				finish: "stop",
				time: { created: 2000, completed: 2100 },
			}),
		);
		await Bun.write(
			join(storage, "part", userId, "prt_u1.json"),
			JSON.stringify({ id: "prt_u1", messageID: userId, type: "text", text: "prompt" }),
		);
		await Bun.write(
			join(storage, "part", assistantId, "prt_a1.json"),
			JSON.stringify({ id: "prt_a1", messageID: assistantId, type: "text", text: "response" }),
		);

		const agent: Agent = { ...baseAgent(), provider: "opencode", providerRuntimeDir: dataHome };
		const result = await readAgentMessages(agent, { role: "all", limit: 10 });

		expect(result.source).toBe("internals_opencode_storage");
		expect(result.messages.map((m) => [m.role, m.text])).toEqual([
			["user", "prompt"],
			["assistant", "response"],
		]);
		expect(result.lastAssistantMessage?.finishReason).toBe("stop");
	});

	it("returns internals_unavailable when runtime metadata is missing", async () => {
		const agent: Agent = { ...baseAgent(), provider: "codex" };
		const result = await readAgentMessages(agent);

		expect(result.source).toBe("internals_unavailable");
		expect(result.messages.length).toBe(0);
		expect(result.warnings.length).toBeGreaterThan(0);
	});
});
