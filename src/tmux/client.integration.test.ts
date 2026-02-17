import { afterEach, describe, expect, it } from "bun:test";
import {
	capturePane,
	createSession,
	createWindow,
	getPaneVar,
	hasSession,
	killSession,
	listSessions,
	sendInput,
	sendKeys,
} from "./client.ts";

const live = process.env["LIVE_TESTS"] === "1";
const describeLive = live ? describe : describe.skip;
const sessionPrefix = `ah-test-${Date.now()}`;
const createdSessions = new Set<string>();

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await check()) return true;
		await Bun.sleep(100);
	}
	return false;
}

afterEach(async () => {
	for (const session of createdSessions) {
		await killSession(session);
	}
	createdSessions.clear();
});

describeLive("tmux/client.session-lifecycle", () => {
	it("creates/lists/kills real tmux sessions", async () => {
		const session = `${sessionPrefix}-lifecycle`;
		createdSessions.add(session);

		const created = await createSession(session, process.cwd());
		expect(created.ok).toBe(true);

		const listed = await listSessions(sessionPrefix);
		expect(listed.ok).toBe(true);
		if (listed.ok) {
			expect(listed.value.some((s) => s.name === session)).toBe(true);
		}

		const killed = await killSession(session);
		expect(killed.ok).toBe(true);
		createdSessions.delete(session);

		expect(await hasSession(session)).toBe(false);
	});
});

describeLive("tmux/client.window-input-capture", () => {
	it("creates window, sends input, captures pane output", async () => {
		const session = `${sessionPrefix}-capture`;
		createdSessions.add(session);
		const created = await createSession(session, process.cwd());
		expect(created.ok).toBe(true);

		const window = await createWindow(session, "echo", process.cwd(), ["cat"]);
		expect(window.ok).toBe(true);
		if (!window.ok) return;
		const pane = window.value;

		const input = await sendInput(pane, "hello-from-test\n");
		expect(input.ok).toBe(true);

		const seen = await waitFor(async () => {
			const captured = await capturePane(pane, 50);
			return captured.ok && captured.value.includes("hello-from-test");
		}, 4000);

		expect(seen).toBe(true);
	});
});

describeLive("tmux/client.sendKeys-abort", () => {
	it("sends C-c to interrupt blocking command", async () => {
		const session = `${sessionPrefix}-abort`;
		createdSessions.add(session);
		const created = await createSession(session, process.cwd());
		expect(created.ok).toBe(true);

		const window = await createWindow(session, "sleeper", process.cwd(), ["sleep", "30"]);
		expect(window.ok).toBe(true);
		if (!window.ok) return;
		const pane = window.value;

		await Bun.sleep(200);
		const aborted = await sendKeys(pane, "C-c");
		expect(aborted.ok).toBe(true);

		const interrupted = await waitFor(async () => {
			const currentCmd = await getPaneVar(pane, "pane_current_command");
			if (currentCmd.ok && currentCmd.value !== "sleep") return true;
			const paneDead = await getPaneVar(pane, "pane_dead");
			return paneDead.ok && paneDead.value === "1";
		}, 8000);

		expect(interrupted).toBe(true);
	}, 15000);
});
