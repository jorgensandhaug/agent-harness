import { Hono } from "hono";
import { cors } from "hono/cors";
import type { EventBus } from "../events/bus.ts";
import type { Manager } from "../session/manager.ts";
import type { Store } from "../session/store.ts";
import * as tmux from "../tmux/client.ts";
import { registerAgentRoutes } from "./agents.ts";
import { registerEventRoutes } from "./events.ts";
import { registerHealthRoutes } from "./health.ts";
import { registerProjectRoutes } from "./projects.ts";

export function createApp(manager: Manager, store: Store, eventBus: EventBus, startTime: number) {
	const app = new Hono();

	// CORS for local development
	app.use("/*", cors());

	// Health is always available (it reports tmux status)
	registerHealthRoutes(app, store, startTime);

	// tmux availability guard for operational routes — returns 503 per spec
	app.use("/api/v1/projects/*", async (c, next) => {
		const check = await tmux.listSessions("__guard__");
		if (!check.ok && check.error.code === "TMUX_NOT_INSTALLED") {
			return c.json(
				{ error: "TMUX_UNAVAILABLE", message: "tmux is not installed or not accessible" },
				503,
			);
		}
		return next();
	});

	registerProjectRoutes(app, manager);
	registerAgentRoutes(app, manager);
	registerEventRoutes(app, manager, eventBus);

	// Catch-all 404
	app.notFound((c) => {
		return c.json({ error: "NOT_FOUND", message: "Route not found" }, 404);
	});

	// Global error handler
	app.onError((e, c) => {
		const message = e instanceof Error ? e.message : String(e);
		return c.json({ error: "INTERNAL_ERROR", message }, 500);
	});

	return app;
}
