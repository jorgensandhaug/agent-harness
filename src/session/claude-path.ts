import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function normalizeClaudeProjectKey(rawPath: string): string {
	// Claude's project dir key is path-derived and replaces punctuation (for example `.worktrees`)
	// with dashes; preserve repeated dashes to match on-disk layout.
	return resolve(rawPath).replaceAll(/[^a-zA-Z0-9-]/g, "-");
}

export function claudeProjectStorageDir(cwd: string): string {
	return join(homedir(), ".claude", "projects", normalizeClaudeProjectKey(cwd));
}

export function claudeSessionFileCandidates(sessionFilePath: string): readonly string[] {
	const resolvedPath = resolve(sessionFilePath);
	const candidates: string[] = [resolvedPath];
	const fileName = basename(resolvedPath);
	if (!fileName.endsWith(".jsonl")) return candidates;

	const projectDir = dirname(resolvedPath);
	const projectsRoot = dirname(projectDir);
	const projectKey = basename(projectDir);
	const normalizedProjectKey = projectKey.replaceAll(/[^a-zA-Z0-9-]/g, "-");
	if (normalizedProjectKey !== projectKey) {
		candidates.push(join(projectsRoot, normalizedProjectKey, fileName));
	}
	return Array.from(new Set(candidates));
}
