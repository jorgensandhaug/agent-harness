import { describe, expect, it } from "bun:test";
import { formatAttachCommand, parseTmuxSessionName } from "./attach.ts";

describe("session.attach", () => {
	it("extracts tmux session name from target", () => {
		expect(parseTmuxSessionName("ah-sess:claude-12")).toBe("ah-sess");
		expect(parseTmuxSessionName("ah-sess")).toBe("ah-sess");
	});

	it("formats attach command", () => {
		expect(formatAttachCommand("ah-sess:codex-01")).toBe("tmux attach -t ah-sess");
		expect(formatAttachCommand("ah-sess")).toBe("tmux attach -t ah-sess");
		expect(formatAttachCommand("")).toBe("tmux attach");
	});
});
