import { describe, expect, it } from "bun:test";
import { claudeCodeProvider } from "./claude-code.ts";

function readFixture(name: string): Promise<string> {
	return Bun.file(new URL(`../../test/fixtures/providers/claude/${name}`, import.meta.url)).text();
}

describe("providers/claude.parseStatus.idle-processing-error-exited", () => {
	it("parses known status markers", async () => {
		const idle = await readFixture("idle.txt");
		const processing = await readFixture("processing.txt");
		const error = await readFixture("error.txt");
		const exited = await readFixture("exited.txt");

		expect(claudeCodeProvider.parseStatus(`noise\n${idle}`)).toBe("idle");
		expect(claudeCodeProvider.parseStatus(processing)).toBe("processing");
		expect(claudeCodeProvider.parseStatus(error)).toBe("error");
		expect(claudeCodeProvider.parseStatus(exited)).toBe("exited");
	});

	it("handles ansi prompt content", () => {
		expect(claudeCodeProvider.parseStatus("\u001b[32m>\u001b[0m")).toBe("idle");
	});
});

describe("providers/claude.parseOutputDiff.events", () => {
	it("maps diff lines to ordered provider events", () => {
		const diff = [
			"\u001b[33m⏺ Read(file.ts)\u001b[0m",
			"⏺ Read completed",
			"Allow read this file:",
			"Continue? (yes/no)",
			"I've completed this.",
			"Error: failed to run",
			"plain text output",
			"~~~",
		].join("\n");

		const events = claudeCodeProvider.parseOutputDiff(diff);
		expect(events).toEqual([
			{ kind: "tool_start", tool: "Read", input: "file.ts" },
			{ kind: "tool_end", tool: "Read", output: "" },
			{ kind: "permission_requested", description: "read this file" },
			{ kind: "question_asked", question: "Continue? (yes/no)", options: ["yes", "no"] },
			{ kind: "completion", summary: "I've completed this." },
			{ kind: "error", message: "Error: failed to run" },
			{ kind: "text", content: "plain text output" },
			{ kind: "unknown", raw: "~~~" },
		]);
	});
});
