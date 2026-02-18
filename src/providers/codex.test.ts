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

	it("does not stay starting on live capture", async () => {
		const live = await readFixture("live-capture.txt");
		expect(codexProvider.parseStatus(live)).not.toBe("starting");
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

describe("providers/codex.buildCommand.safety", () => {
	it("does not emit conflicting dangerous flags when --yolo is present", () => {
		const cmd = codexProvider.buildCommand({
			command: "codex",
			extraArgs: ["--yolo", "--dangerously-bypass-approvals-and-sandbox"],
			env: {},
			enabled: true,
		});

		expect(cmd).toContain("--yolo");
		expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
	});

	it("keeps bypass flag when --yolo is not present", () => {
		const cmd = codexProvider.buildCommand({
			command: "codex",
			extraArgs: ["--dangerously-bypass-approvals-and-sandbox"],
			env: {},
			enabled: true,
		});

		expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
	});
});
