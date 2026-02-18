import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "../session/types.ts";
import { agentId, projectName } from "../types.ts";
import { resolveAgentBrief } from "./agent-response.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
});

function makeCodexAgent(runtimeDir: string, status: "processing" | "idle"): Agent {
	const now = new Date().toISOString();
	return {
		id: agentId("a1b2c3d4"),
		project: projectName("p1"),
		provider: "codex",
		status,
		brief: [],
		task: "test",
		windowName: "codex-a1",
		tmuxTarget: "ah:codex-a1",
		attachCommand: "tmux attach -t ah",
		providerRuntimeDir: runtimeDir,
		createdAt: now,
		lastActivity: now,
		lastCapturedOutput: "",
	};
}

async function writeCodexAssistantMessages(runtimeDir: string, assistantTexts: readonly string[]) {
	const dir = join(runtimeDir, "sessions", "2026", "02", "18");
	await mkdir(dir, { recursive: true });
	const lines: string[] = [];
	for (let i = 0; i < assistantTexts.length; i++) {
		lines.push(
			JSON.stringify({
				timestamp: `2026-02-18T00:00:0${i}.000Z`,
				type: "event_msg",
				payload: { type: "agent_message", message: assistantTexts[i] },
			}),
		);
	}
	await Bun.write(join(dir, "rollout-2026-02-18T00-00-00.jsonl"), lines.join("\n"));
}

describe("api/agent-response.resolveAgentBrief", () => {
	it("returns last 4 assistant first-lines when status is processing", async () => {
		const runtimeDir = await mkdtemp(join(tmpdir(), "ah-brief-processing-"));
		tempDirs.push(runtimeDir);
		await writeCodexAssistantMessages(runtimeDir, [
			"one",
			`${"x".repeat(200)}\nsecond line ignored`,
			"three",
			"four",
			"five",
		]);

		const agent = makeCodexAgent(runtimeDir, "processing");
		const brief = await resolveAgentBrief(agent);

		expect(brief).toEqual(["x".repeat(140), "three", "four", "five"]);
	});

	it("returns only the latest assistant first-line when status is idle", async () => {
		const runtimeDir = await mkdtemp(join(tmpdir(), "ah-brief-idle-"));
		tempDirs.push(runtimeDir);
		await writeCodexAssistantMessages(runtimeDir, [
			"first",
			"second",
			"done line\nextra line ignored",
		]);

		const agent = makeCodexAgent(runtimeDir, "idle");
		const brief = await resolveAgentBrief(agent);

		expect(brief).toEqual(["done line"]);
	});

	it("returns empty array when no assistant messages are available", async () => {
		const runtimeDir = await mkdtemp(join(tmpdir(), "ah-brief-empty-"));
		tempDirs.push(runtimeDir);
		const agent = makeCodexAgent(runtimeDir, "idle");
		const brief = await resolveAgentBrief(agent);

		expect(brief).toEqual([]);
	});
});
