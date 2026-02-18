export function normalizedLines(capturedOutput: string): string[] {
	const lines = capturedOutput.split("\n").map((line) => line.replace(/\r$/, ""));
	while (lines.length > 0) {
		const last = lines[lines.length - 1];
		if (last !== undefined && last.trim().length === 0) {
			lines.pop();
			continue;
		}
		break;
	}
	return lines;
}
