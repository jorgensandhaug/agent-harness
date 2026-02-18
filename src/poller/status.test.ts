import { describe, expect, it } from "bun:test";
import { deriveStatusFromSignals, isLikelyAgentProcessAlive } from "./status.ts";

describe("poller/status.isLikelyAgentProcessAlive", () => {
	it("treats shell commands as not alive and agent commands as alive", () => {
		expect(isLikelyAgentProcessAlive("zsh")).toBe(false);
		expect(isLikelyAgentProcessAlive("bash")).toBe(false);
		expect(isLikelyAgentProcessAlive("claude")).toBe(true);
		expect(isLikelyAgentProcessAlive("node")).toBe(true);
	});
});

describe("poller/status.deriveStatusFromSignals", () => {
	it("keeps parsed non-starting status authoritative", () => {
		const status = deriveStatusFromSignals({
			currentStatus: "processing",
			parsedStatus: "waiting_input",
			paneDead: false,
			paneCurrentCommand: "codex",
			currentOutput: "allow? y/n:",
			diff: "",
			providerEvents: [],
			lastDiffAtMs: 10,
			nowMs: 20,
		});
		expect(status).toBe("waiting_input");
	});

	it("moves starting to processing on fresh diff even when parser returns starting", () => {
		const status = deriveStatusFromSignals({
			currentStatus: "starting",
			parsedStatus: "starting",
			paneDead: false,
			paneCurrentCommand: "node",
			currentOutput: "Reply with exactly: 4",
			diff: "4",
			providerEvents: [{ kind: "text", content: "4" }],
			lastDiffAtMs: 100,
			nowMs: 120,
		});
		expect(status).toBe("processing");
	});

	it("moves processing to idle after quiet period with live process", () => {
		const status = deriveStatusFromSignals({
			currentStatus: "processing",
			parsedStatus: "starting",
			paneDead: false,
			paneCurrentCommand: "claude",
			currentOutput: "some output",
			diff: "",
			providerEvents: [],
			lastDiffAtMs: 1000,
			nowMs: 5001,
		});
		expect(status).toBe("idle");
	});

	it("does not regress idle back to starting on parser miss", () => {
		const status = deriveStatusFromSignals({
			currentStatus: "idle",
			parsedStatus: "starting",
			paneDead: false,
			paneCurrentCommand: "pi",
			currentOutput: "INSERT",
			diff: "",
			providerEvents: [],
			lastDiffAtMs: 1000,
			nowMs: 1100,
		});
		expect(status).toBe("idle");
	});

	it("marks exited when pane is dead regardless of parser output", () => {
		const status = deriveStatusFromSignals({
			currentStatus: "processing",
			parsedStatus: "idle",
			paneDead: true,
			paneCurrentCommand: "zsh",
			currentOutput: "",
			diff: "",
			providerEvents: [],
			lastDiffAtMs: 1000,
			nowMs: 1100,
		});
		expect(status).toBe("exited");
	});
});
