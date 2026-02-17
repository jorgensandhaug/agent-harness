import type { Hono } from "hono";
import type { Store } from "../session/store.ts";
import * as tmux from "../tmux/client.ts";

const VERSION = "0.1.0";

export function registerHealthRoutes(app: Hono, store: Store, startTime: number): void {
	app.get("/api/v1/health", async (c) => {
		const tmuxCheck = await tmux.listSessions("__nonexistent__");
		const tmuxAvailable = tmuxCheck.ok || tmuxCheck.error.code !== "TMUX_NOT_INSTALLED";

		const { projects, agents } = store.stats();

		return c.json({
			uptime: Math.floor((Date.now() - startTime) / 1000),
			projects,
			agents,
			tmuxAvailable,
			version: VERSION,
		});
	});
}
