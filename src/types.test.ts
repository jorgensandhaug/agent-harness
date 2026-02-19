import { describe, expect, it } from "bun:test";
import { isValidAgentId, newAgentId, normalizeAgentIdInput } from "./types.ts";

describe("types.agent-id", () => {
	it("normalizes and validates expected format", () => {
		expect(normalizeAgentIdInput("  codex-bright-fox  ")).toBe("codex-bright-fox");
		expect(isValidAgentId("codex-bright-fox")).toBe(true);
		expect(isValidAgentId("Codex-Bright-Fox")).toBe(false);
		expect(isValidAgentId("ab")).toBe(false);
		expect(isValidAgentId("a".repeat(41))).toBe(false);
		expect(isValidAgentId("codex.bright.fox")).toBe(false);
	});

	it("generates provider-adjective-noun IDs and avoids collisions", () => {
		const taken = new Set<string>();
		const first = newAgentId("codex", taken);
		taken.add(first);
		const second = newAgentId("codex", taken);
		expect(first).toMatch(/^codex-[a-z]{3,8}-[a-z]{3,8}$/);
		expect(second).toMatch(/^codex-[a-z]{3,8}-[a-z]{3,8}(-\d+)?$/);
		expect(second).not.toBe(first);
	});
});
