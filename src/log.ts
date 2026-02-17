type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
	currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
	return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
	if (!shouldLog(level)) return;

	const entry: Record<string, unknown> = {
		ts: new Date().toISOString(),
		level,
		msg,
	};

	if (data) {
		for (const [k, v] of Object.entries(data)) {
			entry[k] = v;
		}
	}

	process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export const log = {
	debug: (msg: string, data?: Record<string, unknown>) => write("debug", msg, data),
	info: (msg: string, data?: Record<string, unknown>) => write("info", msg, data),
	warn: (msg: string, data?: Record<string, unknown>) => write("warn", msg, data),
	error: (msg: string, data?: Record<string, unknown>) => write("error", msg, data),
};
