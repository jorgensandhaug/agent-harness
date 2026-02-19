import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeProjectStorageDir, claudeSessionFileCandidates } from "./claude-path.ts";

describe("session/claude-path", () => {
	it("normalizes dotted path segments in claude project storage dir", () => {
		const cwd = "/home/jorge/repos/Cloudgeni-ai/.worktrees/cloudgeni/feat/clo-103";
		const dir = claudeProjectStorageDir(cwd);
		expect(dir).toBe(
			join(
				homedir(),
				".claude",
				"projects",
				"-home-jorge-repos-Cloudgeni-ai--worktrees-cloudgeni-feat-clo-103",
			),
		);
	});

	it("returns fallback candidate for unsanitized dotted project key", () => {
		const preferred =
			"/home/jorge/.claude/projects/-home-jorge-repos-Cloudgeni-ai-.worktrees-cloudgeni/abc.jsonl";
		const candidates = claudeSessionFileCandidates(preferred);
		expect(candidates).toEqual([
			"/home/jorge/.claude/projects/-home-jorge-repos-Cloudgeni-ai-.worktrees-cloudgeni/abc.jsonl",
			"/home/jorge/.claude/projects/-home-jorge-repos-Cloudgeni-ai--worktrees-cloudgeni/abc.jsonl",
		]);
	});
});
