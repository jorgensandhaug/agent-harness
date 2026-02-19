import { describe, expect, it } from "bun:test";
import { hasInternalsStatusSource, shouldUseUiParserForStatus } from "./status-source.ts";

describe("poller/status-source.hasInternalsStatusSource", () => {
	it("detects claude internals by session file", () => {
		expect(
			hasInternalsStatusSource({
				provider: "claude-code",
				providerSessionFile: "/tmp/claude-session.jsonl",
			}),
		).toBe(true);
		expect(
			hasInternalsStatusSource({
				provider: "claude-code",
			}),
		).toBe(false);
	});

	it("detects runtime-dir internals for codex/pi/opencode", () => {
		expect(
			hasInternalsStatusSource({
				provider: "codex",
				providerRuntimeDir: "/tmp/codex-home",
			}),
		).toBe(true);
		expect(
			hasInternalsStatusSource({
				provider: "pi",
				providerRuntimeDir: "/tmp/pi-home",
			}),
		).toBe(true);
		expect(
			hasInternalsStatusSource({
				provider: "opencode",
				providerRuntimeDir: "/tmp/xdg-data",
			}),
		).toBe(true);
	});
});

describe("poller/status-source.shouldUseUiParserForStatus", () => {
	it("disables ui-parser status for codex and for providers with internals", () => {
		expect(
			shouldUseUiParserForStatus({
				provider: "codex",
			}),
		).toBe(false);
		expect(
			shouldUseUiParserForStatus({
				provider: "codex",
				providerRuntimeDir: "/tmp/codex-home",
			}),
		).toBe(false);
		expect(
			shouldUseUiParserForStatus({
				provider: "claude-code",
				providerSessionFile: "/tmp/claude-session.jsonl",
			}),
		).toBe(false);
	});

	it("allows ui-parser status only when provider has no internals path", () => {
		expect(
			shouldUseUiParserForStatus({
				provider: "unknown-provider",
			}),
		).toBe(true);
	});
});
