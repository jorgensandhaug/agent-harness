import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentId, projectName } from "../types.ts";
import { createCallbackState } from "./callback-state.ts";

const cleanupDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("session/callback-state", () => {
	it("persists and reloads project + agent callbacks", async () => {
		const logDir = await makeTempDir("ah-callback-state-");
		const project = projectName("p-callback-state");
		const id = agentId("codex-callback-state");

		const state1 = createCallbackState(logDir);
		await state1.setProjectCallback(project, {
			url: " https://callback.test/project ",
			token: " project-token ",
			discordChannel: " alerts ",
			sessionKey: " session-main ",
			extra: { requestId: "req-1" },
		});
		await state1.setAgentCallback(project, id, {
			url: "https://callback.test/agent",
			token: "agent-token",
		});

		const state2 = createCallbackState(logDir);
		const projectCallback = await state2.getProjectCallback(project);
		const agentCallback = await state2.getAgentCallback(project, id);

		expect(projectCallback).toEqual({
			url: "https://callback.test/project",
			token: "project-token",
			discordChannel: "alerts",
			sessionKey: "session-main",
			extra: { requestId: "req-1" },
		});
		expect(agentCallback).toEqual({
			url: "https://callback.test/agent",
			token: "agent-token",
		});
	});

	it("ignores invalid callback entries and falls back to empty state", async () => {
		const logDir = await makeTempDir("ah-callback-invalid-");
		const stateDir = join(logDir, "state");
		await mkdir(stateDir, { recursive: true });
		await writeFile(
			join(stateDir, "callbacks.json"),
			JSON.stringify({
				version: 1,
				projects: {
					"p-invalid": { url: "" },
				},
				agents: {
					"p-invalid:agent-invalid": { url: "https://ok.test", extra: { count: 7 } },
				},
			}),
			"utf8",
		);

		const state = createCallbackState(logDir);
		const projectCallback = await state.getProjectCallback(projectName("p-invalid"));
		const agentCallback = await state.getAgentCallback(
			projectName("p-invalid"),
			agentId("agent-invalid"),
		);
		expect(projectCallback).toBeUndefined();
		expect(agentCallback).toBeUndefined();
	});

	it("prunes stale project and agent entries", async () => {
		const logDir = await makeTempDir("ah-callback-prune-");
		const state = createCallbackState(logDir);
		await state.setProjectCallback(projectName("p-active"), {
			url: "https://callback.test/active",
		});
		await state.setProjectCallback(projectName("p-stale"), { url: "https://callback.test/stale" });
		await state.setAgentCallback(projectName("p-active"), agentId("agent-active"), {
			url: "https://callback.test/agent-active",
		});
		await state.setAgentCallback(projectName("p-stale"), agentId("agent-stale"), {
			url: "https://callback.test/agent-stale",
		});

		await state.prune(new Set([projectName("p-active")]), new Set(["p-active:agent-active"]));

		expect(await state.getProjectCallback(projectName("p-active"))).toEqual({
			url: "https://callback.test/active",
		});
		expect(await state.getProjectCallback(projectName("p-stale"))).toBeUndefined();
		expect(await state.getAgentCallback(projectName("p-active"), agentId("agent-active"))).toEqual({
			url: "https://callback.test/agent-active",
		});
		expect(
			await state.getAgentCallback(projectName("p-stale"), agentId("agent-stale")),
		).toBeUndefined();
	});
});
