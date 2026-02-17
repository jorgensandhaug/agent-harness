import { describe, expect, it } from "bun:test";
import { opencodeProvider } from "./opencode.ts";

function readFixture(name: string): Promise<string> {
	return Bun.file(new URL(`../../test/fixtures/providers/opencode/${name}`, import.meta.url)).text();
}

describe("providers/opencode.parseStatus.smoke", () => {
	it("covers idle/processing/error/waiting_input with synthetic + fixture text", async () => {
		const captured = await readFixture("captured.txt");

		expect(opencodeProvider.parseStatus("\n❯ ")).toBe("idle");
		expect(opencodeProvider.parseStatus(captured)).toBe("processing");
		expect(opencodeProvider.parseStatus("line\nFailed: timeout")).toBe("error");
		expect(opencodeProvider.parseStatus("allow deploy? y/n:")).toBe("waiting_input");
	});
});

describe("providers/opencode.parseOutputDiff.events", () => {
	it("maps permission/error/text/unknown events", () => {
		const events = opencodeProvider.parseOutputDiff(
			["allow deploy? y/n:", "Error: boom", "ok 4", ":::", "❯", "⠧"].join("\n"),
		);
		expect(events).toEqual([
			{ kind: "permission_requested", description: "allow deploy? y/n:" },
			{ kind: "error", message: "Error: boom" },
			{ kind: "text", content: "ok 4" },
			{ kind: "unknown", raw: ":::" },
		]);
	});
});
