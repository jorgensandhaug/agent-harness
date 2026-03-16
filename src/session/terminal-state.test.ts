import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentId, projectName } from "../types.ts";
import { createTerminalState, defaultTerminalState } from "./terminal-state.ts";

const cleanupDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("session/terminal-state", () => {
	it("persists and reloads finalized delivery state", async () => {
		const logDir = await makeTempDir("ah-terminal-state-");
		const state1 = createTerminalState(logDir);
		await state1.setAgentState(projectName("p-terminal"), agentId("agent-terminal"), {
			pollState: "quiesced",
			terminalStatus: "idle",
			terminalObservedAt: "2026-02-18T09:59:58.000Z",
			terminalQuietSince: "2026-02-18T09:59:59.000Z",
			finalizedAt: "2026-02-18T10:00:00.000Z",
			finalMessage: "final answer",
			finalMessageSource: "internals_codex_jsonl",
			deliveryState: "sent",
			deliveryInFlight: false,
			deliveryId: "delivery-1",
			deliverySentAt: "2026-02-18T10:00:01.000Z",
		});

		const state2 = createTerminalState(logDir);
		await expect(
			state2.getAgentState(projectName("p-terminal"), agentId("agent-terminal")),
		).resolves.toEqual({
			pollState: "quiesced",
			terminalStatus: "idle",
			terminalObservedAt: "2026-02-18T09:59:58.000Z",
			terminalQuietSince: "2026-02-18T09:59:59.000Z",
			finalizedAt: "2026-02-18T10:00:00.000Z",
			finalMessage: "final answer",
			finalMessageSource: "internals_codex_jsonl",
			deliveryState: "sent",
			deliveryInFlight: false,
			deliveryId: "delivery-1",
			deliverySentAt: "2026-02-18T10:00:01.000Z",
		});
	});

	it("drops default active state instead of persisting it", async () => {
		const logDir = await makeTempDir("ah-terminal-default-");
		const state = createTerminalState(logDir);
		await state.setAgentState(
			projectName("p-terminal"),
			agentId("agent-terminal"),
			defaultTerminalState(),
		);

		await expect(
			state.getAgentState(projectName("p-terminal"), agentId("agent-terminal")),
		).resolves.toBeUndefined();
	});

	it("ignores invalid persisted entries and prunes stale agents", async () => {
		const logDir = await makeTempDir("ah-terminal-invalid-");
		const stateDir = join(logDir, "state");
		await mkdir(stateDir, { recursive: true });
		await writeFile(
			join(stateDir, "terminal.json"),
			JSON.stringify({
				version: 1,
				agents: {
					"p-good:agent-good": {
						pollState: "quiesced",
						terminalStatus: "idle",
						terminalObservedAt: "2026-02-18T09:59:58.000Z",
						terminalQuietSince: "2026-02-18T09:59:59.000Z",
						finalizedAt: "2026-02-18T10:00:00.000Z",
						finalMessage: "done",
						finalMessageSource: "internals_codex_jsonl",
						deliveryState: "pending",
						deliveryInFlight: false,
						deliveryId: "delivery-1",
						deliverySentAt: null,
					},
					"p-bad:agent-bad": {
						pollState: "unknown",
						deliveryState: "sent",
					},
				},
			}),
			"utf8",
		);

		const state = createTerminalState(logDir);
		await expect(
			state.getAgentState(projectName("p-bad"), agentId("agent-bad")),
		).resolves.toBeUndefined();

		await state.prune(new Set(["p-good:agent-good"]));
		await expect(
			state.getAgentState(projectName("p-good"), agentId("agent-good")),
		).resolves.toEqual({
			pollState: "quiesced",
			terminalStatus: "idle",
			terminalObservedAt: "2026-02-18T09:59:58.000Z",
			terminalQuietSince: "2026-02-18T09:59:59.000Z",
			finalizedAt: "2026-02-18T10:00:00.000Z",
			finalMessage: "done",
			finalMessageSource: "internals_codex_jsonl",
			deliveryState: "pending",
			deliveryInFlight: false,
			deliveryId: "delivery-1",
			deliverySentAt: null,
		});
	});
});
