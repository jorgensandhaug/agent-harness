import { describe, expect, it } from "bun:test";
import { getProvider, listProviders } from "./registry.ts";

describe("providers/registry", () => {
	it("lists only allowed providers", () => {
		expect(listProviders()).toEqual(["claude-code", "codex"]);
	});

	it("keeps provider lookup available for built-in providers", () => {
		expect(getProvider("claude-code").ok).toBe(true);
		expect(getProvider("codex").ok).toBe(true);
	});
});
