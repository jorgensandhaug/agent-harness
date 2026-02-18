import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
		expect(third.status).toBe("idle");
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
});
