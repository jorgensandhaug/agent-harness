/**
 * Computes the diff between a previous pane capture and a new capture.
 * Returns only the new content that appeared since last capture.
 *
 * Algorithm: find the tail of the previous capture in the current capture,
 * then return everything after that anchor point. Terminal output appends
 * at the bottom, so new content is always after the anchor.
 *
 * Anchor size is configurable (default 10 lines) — larger anchors reduce
 * false matches from repeated lines but need more overlap to work.
 */
const ANCHOR_SIZE = 10;

export function diffCaptures(previous: string, current: string): string {
	if (!previous) return current;
	if (previous === current) return "";

	const prevLines = previous.split("\n");
	const currLines = current.split("\n");

	// Use the tail of previous as an anchor to find where it appears in current.
	// Smaller captures may have fewer lines than ANCHOR_SIZE.
	const anchorSize = Math.min(prevLines.length, ANCHOR_SIZE);
	const anchor = prevLines.slice(-anchorSize);

	// Scan current for the anchor sequence
	const maxStart = currLines.length - anchorSize;
	for (let i = maxStart; i >= 0; i--) {
		let match = true;
		for (let j = 0; j < anchorSize; j++) {
			if (currLines[i + j] !== anchor[j]) {
				match = false;
				break;
			}
		}
		if (match) {
			const newStart = i + anchorSize;
			if (newStart >= currLines.length) return "";
			return currLines.slice(newStart).join("\n");
		}
	}

	// Anchor not found — try single last line as fallback
	const lastPrev = prevLines[prevLines.length - 1];
	if (lastPrev !== undefined && lastPrev.trim().length > 0) {
		for (let i = currLines.length - 1; i >= 0; i--) {
			if (currLines[i] === lastPrev && i < currLines.length - 1) {
				return currLines.slice(i + 1).join("\n");
			}
		}
	}

	// No overlap at all — return entire current (content scrolled past capture window)
	return current;
}
