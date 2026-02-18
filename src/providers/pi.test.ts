import { describe, expect, it } from "bun:test";
import { piProvider } from "./pi.ts";

function readFixture(name: string): Promise<string> {
	return Bun.file(new URL(`../../test/fixtures/providers/pi/${name}`, import.meta.url)).text();
}

describe("providers/pi.parseStatus.smoke", () => {
	it("covers idle/processing/error/waiting_input with synthetic + fixture text", async () => {
		const captured = await readFixture("captured.txt");

		expect(piProvider.parseStatus("\n> ")).toBe("idle");
		expect(piProvider.parseStatus(captured)).toBe("processing");
		expect(piProvider.parseStatus("line\nERROR: bad")).toBe("error");
		expect(piProvider.parseStatus("approve action? yes/no:")).toBe("waiting_input");
	});

	it("does not stay starting on live capture", async () => {
		const live = await readFixture("live-capture.txt");
		expect(piProvider.parseStatus(live)).not.toBe("starting");
	});
});

describe("providers/pi.parseOutputDiff.events", () => {
	it("maps permission/error/text/unknown events", () => {
		const events = piProvider.parseOutputDiff(
			["approve action? yes/no:", "failed to run", "result 4", "~~~", ">", "⠹"].join("\n"),
		);
		expect(events).toEqual([
			{ kind: "permission_requested", description: "approve action? yes/no:" },
			{ kind: "error", message: "failed to run" },
			{ kind: "text", content: "result 4" },
			{ kind: "unknown", raw: "~~~" },
		]);
	});
});
