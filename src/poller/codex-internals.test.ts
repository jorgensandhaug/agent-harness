import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newCodexInternalsCursor, readCodexInternalsStatus } from "./codex-internals.ts";

async function append(path: string, lines: readonly string[]): Promise<void> {
	await writeFile(path, `${lines.join("\n")}\n`, { flag: "a" });
}

describe("poller/codex-internals.readCodexInternalsStatus", () => {
	it("tracks task_started -> task_complete transitions from codex internal events", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-codex-internals-"));
		const sessionsDir = join(root, "sessions", "2026", "02", "17");
		await mkdir(sessionsDir, { recursive: true });
		const file = join(sessionsDir, "rollout-2026-02-17T19-01-25-thread.jsonl");

		await append(file, [
			JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
			JSON.stringify({ type: "event_msg", payload: { type: "agent_reasoning" } }),
		]);

		let cursor = newCodexInternalsCursor();
		const first = await readCodexInternalsStatus(root, cursor);
		cursor = first.cursor;
		expect(first.status).toBe("processing");
		expect(first.parseErrorCount).toBe(0);

		await append(file, [
			JSON.stringify({
				type: "response_item",
				payload: { type: "message", role: "assistant", phase: "final_answer" },
			}),
			JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
		]);

		const second = await readCodexInternalsStatus(root, cursor);
		expect(second.status).toBe("idle");
		expect(second.parseErrorCount).toBe(0);
	});

	it("reports parse errors but keeps last good status", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-codex-internals-"));
		const sessionsDir = join(root, "sessions", "2026", "02", "17");
		await mkdir(sessionsDir, { recursive: true });
		const file = join(sessionsDir, "rollout-2026-02-17T19-01-26-thread.jsonl");

		await append(file, [JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })]);
		let cursor = newCodexInternalsCursor();
		const first = await readCodexInternalsStatus(root, cursor);
		cursor = first.cursor;
		expect(first.status).toBe("processing");

		await append(file, [
			"{not-json}",
			JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
		]);
		const second = await readCodexInternalsStatus(root, cursor);
		expect(second.parseErrorCount).toBe(1);
		expect(second.status).toBe("processing");
	});

	it("ignores task_complete for subagent sessions", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-codex-internals-"));
		const sessionsDir = join(root, "sessions", "2026", "02", "17");
		await mkdir(sessionsDir, { recursive: true });
		const file = join(sessionsDir, "rollout-2026-02-17T19-01-27-thread.jsonl");

		await append(file, [
			JSON.stringify({
				type: "session_meta",
				payload: {
					source: {
						subagent: {
							thread_spawn: {
								parent_thread_id: "parent-thread",
								depth: 1,
							},
						},
					},
				},
			}),
			JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
			JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
		]);

		const result = await readCodexInternalsStatus(root, newCodexInternalsCursor());
		expect(result.status).toBe("processing");
		expect(result.cursor.isSubagentSession).toBe(true);
		expect(result.parseErrorCount).toBe(0);
	});

	it("prefers newest non-subagent session when latest session is from a subagent", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-codex-internals-"));
		const sessionsDir = join(root, "sessions", "2026", "02", "17");
		await mkdir(sessionsDir, { recursive: true });
		const mainFile = join(sessionsDir, "rollout-2026-02-17T19-01-27-thread.jsonl");
		const subagentFile = join(sessionsDir, "rollout-2026-02-17T19-01-28-thread.jsonl");

		await append(mainFile, [
			JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
			JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
		]);
		await append(subagentFile, [
			JSON.stringify({
				type: "session_meta",
				payload: {
					source: {
						subagent: {
							thread_spawn: {
								parent_thread_id: "parent-thread",
								depth: 1,
							},
						},
					},
				},
			}),
			JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
			JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
		]);

		const result = await readCodexInternalsStatus(root, newCodexInternalsCursor());
		expect(result.cursor.sessionFile).toBe(mainFile);
		expect(result.status).toBe("idle");
		expect(result.parseErrorCount).toBe(0);
	});
});
