import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newPiInternalsCursor, readPiInternalsStatus } from "./pi-internals.ts";

async function writeLines(path: string, lines: readonly string[]): Promise<void> {
	await Bun.write(path, `${lines.join("\n")}\n`);
}

describe("poller/pi-internals.readPiInternalsStatus", () => {
	const cleanup: string[] = [];

	afterEach(async () => {
		await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	it("tracks user -> assistant transitions from PI session jsonl", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-pi-internals-"));
		cleanup.push(root);
		const sessionsDir = join(root, "sessions", "--home-jorge-repos-agent-harness--");
		await mkdir(sessionsDir, { recursive: true });
		const file = join(sessionsDir, "2026-02-17T19-01-25-111Z_a.jsonl");

		await writeLines(file, [JSON.stringify({ type: "message", message: { role: "user" } })]);

		const first = await readPiInternalsStatus(root, newPiInternalsCursor());
		expect(first.status).toBe("processing");

		await writeLines(file, [
			JSON.stringify({ type: "message", message: { role: "user" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop" } }),
		]);
		const second = await readPiInternalsStatus(root, first.cursor);
		expect(second.status).toBe("idle");
	});

	it("maps assistant stopReason=error to error", async () => {
		const root = await mkdtemp(join(tmpdir(), "ah-pi-internals-"));
		cleanup.push(root);
		const sessionsDir = join(root, "sessions", "--home-jorge-repos-agent-harness--");
		await mkdir(sessionsDir, { recursive: true });
		const file = join(sessionsDir, "2026-02-17T19-01-26-111Z_a.jsonl");

		await writeLines(file, [
			JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "error" } }),
		]);
		const result = await readPiInternalsStatus(root, newPiInternalsCursor());
		expect(result.status).toBe("error");
	});
});
