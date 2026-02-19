import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newClaudeInternalsCursor, readClaudeInternalsStatus } from "./claude-internals.ts";

async function append(path: string, lines: readonly string[]): Promise<void> {
	const content = `${lines.join("\n")}\n`;
	await Bun.write(path, content);
}

describe("poller/claude-internals.readClaudeInternalsStatus", () => {
	const cleanup: string[] = [];

	afterEach(async () => {
		await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	it("tracks queue enqueue -> user -> assistant transitions", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-claude-internals-"));
		cleanup.push(root);
		const sessionFile = join(root, "session.jsonl");

		await append(sessionFile, [JSON.stringify({ type: "queue-operation", operation: "enqueue" })]);
		const first = await readClaudeInternalsStatus(sessionFile, newClaudeInternalsCursor());
		expect(first.status).toBe("processing");

		await append(sessionFile, [
			JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
			JSON.stringify({ type: "user" }),
		]);
		const second = await readClaudeInternalsStatus(sessionFile, first.cursor);
		expect(second.status).toBe("processing");

		await append(sessionFile, [
			JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
			JSON.stringify({ type: "user" }),
			JSON.stringify({ type: "assistant", message: { stop_reason: null } }),
		]);
		const third = await readClaudeInternalsStatus(sessionFile, second.cursor);
		expect(third.status).toBe("processing");

		await append(sessionFile, [
			JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
			JSON.stringify({ type: "user" }),
			JSON.stringify({ type: "assistant", message: { stop_reason: null } }),
			JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn" } }),
		]);
		const fourth = await readClaudeInternalsStatus(sessionFile, third.cursor);
		expect(fourth.status).toBe("idle");
	});

	it("keeps processing for non-terminal assistant stop reasons", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-claude-internals-"));
		cleanup.push(root);
		const sessionFile = join(root, "session.jsonl");

		await append(sessionFile, [
			JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use" } }),
		]);
		const toolUse = await readClaudeInternalsStatus(sessionFile, newClaudeInternalsCursor());
		expect(toolUse.status).toBe("processing");

		await append(sessionFile, [
			JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use" } }),
			JSON.stringify({ type: "assistant", message: { stop_reason: "pause_turn" } }),
		]);
		const pauseTurn = await readClaudeInternalsStatus(sessionFile, toolUse.cursor);
		expect(pauseTurn.status).toBe("processing");

		await append(sessionFile, [
			JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use" } }),
			JSON.stringify({ type: "assistant", message: { stop_reason: "pause_turn" } }),
			JSON.stringify({ type: "assistant", message: { stop_reason: "stop_sequence" } }),
		]);
		const stopSequence = await readClaudeInternalsStatus(sessionFile, pauseTurn.cursor);
		expect(stopSequence.status).toBe("idle");
	});

	it("maps assistant stop_reason=error to error", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-claude-internals-"));
		cleanup.push(root);
		const sessionFile = join(root, "session.jsonl");

		await append(sessionFile, [
			JSON.stringify({ type: "assistant", message: { stop_reason: "error" } }),
		]);
		const first = await readClaudeInternalsStatus(sessionFile, newClaudeInternalsCursor());
		expect(first.status).toBe("error");

		await append(sessionFile, [
			JSON.stringify({ type: "assistant", message: { stop_reason: "error" } }),
			JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn" } }),
		]);
		const second = await readClaudeInternalsStatus(sessionFile, first.cursor);
		expect(second.status).toBe("idle");
	});

	it("reports parse errors and keeps last good status", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-claude-internals-"));
		cleanup.push(root);
		const sessionFile = join(root, "session.jsonl");

		await append(sessionFile, [JSON.stringify({ type: "user" })]);
		const first = await readClaudeInternalsStatus(sessionFile, newClaudeInternalsCursor());
		expect(first.status).toBe("processing");

		await append(sessionFile, [JSON.stringify({ type: "user" }), "{invalid-json"]);
		const second = await readClaudeInternalsStatus(sessionFile, first.cursor);
		expect(second.status).toBe("processing");
		expect(second.parseErrorCount).toBe(1);
	});

	it("reads internals via fallback when claude project key contains dots", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-claude-internals-fallback-"));
		cleanup.push(root);
		const projectsRoot = join(root, ".claude", "projects");
		const actualDir = join(projectsRoot, "-tmp--worktrees-demo");
		await mkdir(actualDir, { recursive: true });
		const sessionFileName = "952db2ba-36b6-4389-b515-24c376e96b2f.jsonl";
		const actualFile = join(actualDir, sessionFileName);
		await append(actualFile, [JSON.stringify({ type: "user" })]);

		const missingPreferredPath = join(projectsRoot, "-tmp-.worktrees-demo", sessionFileName);
		const result = await readClaudeInternalsStatus(
			missingPreferredPath,
			newClaudeInternalsCursor(),
		);
		expect(result.status).toBe("processing");
		expect(result.parseErrorCount).toBe(0);
	});
});
