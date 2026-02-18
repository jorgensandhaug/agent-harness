export function parseTmuxSessionName(tmuxTarget: string): string {
	return tmuxTarget.split(":")[0] ?? "";
}

export function formatAttachCommand(tmuxTarget: string): string {
	const session = parseTmuxSessionName(tmuxTarget);
	if (!session) return "tmux attach";
	return `tmux attach -t ${session}`;
}
