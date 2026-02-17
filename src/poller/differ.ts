/**
 * Computes the diff between a previous capture and a new capture.
 * Returns only the new lines (content that appeared since last capture).
 *
 * Strategy: Find the longest common suffix between old and new,
 * then return everything in new that comes after the shared portion.
 * If no overlap is found, return all of new (first capture or output scrolled past).
 */
export function diffCaptures(previous: string, current: string): string {
	if (!previous) return current;
	if (previous === current) return "";

	const prevLines = previous.split("\n");
	const currLines = current.split("\n");

	// Find how many lines from the end of previous match the end of current
	// This handles the case where old content scrolled up and new content appeared at bottom
	let matchLen = 0;
	const maxCheck = Math.min(prevLines.length, currLines.length);

	for (let i = 1; i <= maxCheck; i++) {
		const prevLine = prevLines[prevLines.length - i];
		const currIdx = currLines.length - i;

		// Scan backwards in current looking for where previous tail starts
		if (prevLine === currLines[currIdx]) {
			matchLen = i;
		} else {
			break;
		}
	}

	if (matchLen === 0) {
		// No overlap found — could be completely new content or major scroll
		// Try to find the last line of previous somewhere in current
		const lastPrevLine = prevLines[prevLines.length - 1];
		if (lastPrevLine && lastPrevLine.trim().length > 0) {
			const idx = currLines.lastIndexOf(lastPrevLine);
			if (idx !== -1 && idx < currLines.length - 1) {
				return currLines.slice(idx + 1).join("\n");
			}
		}
		// Completely new content
		return current;
	}

	// New lines are those in current that come after the overlapping suffix
	const newLineCount = currLines.length - matchLen;
	if (newLineCount <= 0) return "";

	// But we need to account for the case where the matching block
	// is at the end of current, and new lines are above it...
	// Actually: matched lines are at the END of both. New content in current
	// is everything before the matched portion that wasn't in previous.
	//
	// In a terminal with scrollback, new content appears at the bottom.
	// So the non-matching lines at the beginning of current are old scrollback,
	// and new content is at the bottom (which we already matched).
	//
	// Wait — rethinking: if prev = [A, B, C] and curr = [B, C, D, E],
	// the common suffix from the end would be 0 (C != E).
	// We need a different approach.

	// Better approach: find where the end of prev appears in curr
	// and take everything after that point.
	const prevTailSize = Math.min(prevLines.length, 10);
	const prevTail = prevLines.slice(-prevTailSize);

	for (let startInCurr = 0; startInCurr <= currLines.length - prevTailSize; startInCurr++) {
		let matches = true;
		for (let j = 0; j < prevTailSize; j++) {
			if (currLines[startInCurr + j] !== prevTail[j]) {
				matches = false;
				break;
			}
		}
		if (matches) {
			const newStart = startInCurr + prevTailSize;
			if (newStart >= currLines.length) return "";
			return currLines.slice(newStart).join("\n");
		}
	}

	// Fallback: return lines in current beyond previous length
	if (currLines.length > prevLines.length) {
		return currLines.slice(prevLines.length).join("\n");
	}

	return "";
}
