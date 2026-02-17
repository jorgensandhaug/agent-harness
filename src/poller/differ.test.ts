import { describe, expect, it } from "bun:test";
import { diffCaptures } from "./differ.ts";

describe("poller/differ.basic-overlap", () => {
	it("returns only newly appended lines", () => {
		const previous = ["one", "two", "three"].join("\n");
		const current = ["one", "two", "three", "four", "five"].join("\n");
		expect(diffCaptures(previous, current)).toBe(["four", "five"].join("\n"));
	});
});

describe("poller/differ.repeated-lines-scrollback", () => {
	it("stably diffs when repeated lines + scrollback shift overlap", () => {
		const previous = ["a", "b", "a", "b", "c"].join("\n");
		const current = ["a", "b", "c", "a", "b", "c", "d"].join("\n");
		expect(diffCaptures(previous, current)).toBe("d");
	});
});
