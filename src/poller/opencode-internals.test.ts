import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newOpenCodeInternalsCursor, readOpenCodeInternalsStatus } from "./opencode-internals.ts";

async function writeJson(path: string, value: unknown): Promise<void> {
	await Bun.write(path, JSON.stringify(value, null, 2));
}

describe("poller/opencode-internals.readOpenCodeInternalsStatus", () => {
	const cleanup: string[] = [];

	afterEach(async () => {
		await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	it("derives processing while assistant response is incomplete, then idle on stop", async () => {
		const dataHome = await mkdtemp(join(tmpdir(), "ah-opencode-internals-"));
		cleanup.push(dataHome);
		const storageRoot = join(dataHome, "opencode", "storage");
		const sessionRoot = join(storageRoot, "session", "project-a");
		const messageRoot = join(storageRoot, "message", "ses_abc");
		await mkdir(sessionRoot, { recursive: true });
		await mkdir(messageRoot, { recursive: true });

		await writeJson(join(sessionRoot, "ses_abc.json"), { id: "ses_abc" });
		await writeJson(join(messageRoot, "msg_user.json"), {
			id: "msg_user",
			role: "user",
			time: { created: 1000 },
		});

		const first = await readOpenCodeInternalsStatus(dataHome, newOpenCodeInternalsCursor());
		expect(first.status).toBe("processing");

		await writeJson(join(messageRoot, "msg_assistant.json"), {
			id: "msg_assistant",
			role: "assistant",
			time: { created: 1001 },
			finish: "tool-calls",
		});
		const second = await readOpenCodeInternalsStatus(dataHome, first.cursor);
		expect(second.status).toBe("processing");

		await writeJson(join(messageRoot, "msg_assistant.json"), {
			id: "msg_assistant",
			role: "assistant",
			time: { created: 1001, completed: 1002 },
			finish: "stop",
		});
		const third = await readOpenCodeInternalsStatus(dataHome, second.cursor);
		expect(third.status).toBe("idle");
	});

	it("maps tool part error to error status", async () => {
		const dataHome = await mkdtemp(join(tmpdir(), "ah-opencode-internals-"));
		cleanup.push(dataHome);
		const storageRoot = join(dataHome, "opencode", "storage");
		const sessionRoot = join(storageRoot, "session", "project-a");
		const messageRoot = join(storageRoot, "message", "ses_abc");
		const partRoot = join(storageRoot, "part", "msg_assistant");
		await mkdir(sessionRoot, { recursive: true });
		await mkdir(messageRoot, { recursive: true });
		await mkdir(partRoot, { recursive: true });

		await writeJson(join(sessionRoot, "ses_abc.json"), { id: "ses_abc" });
		await writeJson(join(messageRoot, "msg_assistant.json"), {
			id: "msg_assistant",
			role: "assistant",
			time: { created: 1001, completed: 1002 },
			finish: "stop",
		});
		await writeJson(join(partRoot, "part.json"), {
			type: "tool",
			state: { status: "error" },
		});

		const result = await readOpenCodeInternalsStatus(dataHome, newOpenCodeInternalsCursor());
		expect(result.status).toBe("error");
	});
});
