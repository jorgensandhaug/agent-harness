import type { Context } from "hono";

export function isCompact(c: Context): boolean {
	const value = c.req.query("compact");
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "true" || normalized === "1";
}

export function responseMode(c: Context): "compact" | "full" {
	return isCompact(c) ? "compact" : "full";
}
