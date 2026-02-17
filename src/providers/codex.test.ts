import { describe, expect, it } from "bun:test";
import { codexProvider } from "./codex.ts";

function readFixture(name: string): Promise<string> {
	return Bun.file(new URL(`../../test/fixtures/providers/codex/${name}`, import.meta.url)).text();
}

describe("providers/codex.parseStatus.smoke", () => {
	it("covers idle/processing/error/waiting_input with synthetic + fixture text", async () => {
		const captured = await readFixture("captured.txt");

		expect(codexProvider.parseStatus("\n❯ ")).toBe("idle");
		expect(codexProvider.parseStatus(captured)).toBe("processing");
		expect(codexProvider.parseStatus("line\nError: request failed")).toBe("error");
		expect(codexProvider.parseStatus("allow command? y/n:")).toBe("waiting_input");
	});
});

describe("providers/codex.parseOutputDiff.events", () => {
	it("maps permission/error/text/unknown events", () => {
		const events = codexProvider.parseOutputDiff(
			["allow command? y/n:", "Error: boom", "answer is 4", "***", "❯", "⠙"].join("\n"),
		);
		expect(events).toEqual([
			{ kind: "permission_requested", description: "allow command? y/n:" },
			{ kind: "error", message: "Error: boom" },
			{ kind: "text", content: "answer is 4" },
			{ kind: "unknown", raw: "***" },
		]);
	});
});
