function stringifyValue(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	return JSON.stringify(value);
}

export function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

export function printNdjson(value: unknown): void {
	console.log(JSON.stringify(value));
}

export function printText(value: string): void {
	console.log(value);
}

export function printError(value: string): void {
	console.error(value);
}

export function printKeyValue(entries: Array<{ key: string; value: unknown }>): void {
	if (entries.length === 0) return;
	const keyWidth = Math.max(...entries.map((entry) => entry.key.length));
	for (const entry of entries) {
		const padded = entry.key.padEnd(keyWidth, " ");
		console.log(`${padded}  ${stringifyValue(entry.value)}`);
	}
}

export function printTable(headers: string[], rows: Array<Array<unknown>>): void {
	if (headers.length === 0) return;
	const normalizedRows = rows.map((row) => headers.map((_, index) => stringifyValue(row[index])));
	const widths = headers.map((header, index) => {
		const rowWidth = Math.max(0, ...normalizedRows.map((row) => row[index]?.length ?? 0));
		return Math.max(header.length, rowWidth);
	});

	const formatRow = (values: string[]): string =>
		values.map((value, index) => value.padEnd(widths[index] ?? value.length, " ")).join("  ");

	console.log(formatRow(headers));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const row of normalizedRows) {
		console.log(formatRow(row));
	}
}

export function formatApiError(status: number, code: string, message: string): string {
	return `HTTP ${status} ${code}: ${message}`;
}
