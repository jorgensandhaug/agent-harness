import { Hono } from "hono";
import { cors } from "hono/cors";
import type { DebugTracker } from "../debug/tracker.ts";
import type { EventBus } from "../events/bus.ts";
import type { Manager } from "../session/manager.ts";
import type { Store } from "../session/store.ts";
import * as tmux from "../tmux/client.ts";
import type { WebhookClient } from "../webhook/client.ts";
import { registerAgentRoutes } from "./agents.ts";
import { registerDebugRoutes } from "./debug.ts";
import { registerEventRoutes } from "./events.ts";
import { registerHealthRoutes } from "./health.ts";
import { registerInspectRoutes } from "./inspect.ts";
import { registerProjectRoutes } from "./projects.ts";
import { registerSubscriptionRoutes } from "./subscriptions.ts";
import { registerWebhookRoutes } from "./webhook.ts";

export function createApp(
	manager: Manager,
	store: Store,
	eventBus: EventBus,
	debugTracker: DebugTracker,
	startTime: number,
	authToken?: string,
	webhookClient?: WebhookClient | null,
) {
	const app = new Hono();

	// CORS for local development
	app.use("/*", cors());

	// Health is always available (it reports tmux status)
	registerHealthRoutes(app, store, startTime);

	// Optional bearer-token auth for API routes, excluding health.
	app.use("/api/v1/*", async (c, next) => {
		if (!authToken) return next();
		if (c.req.path === "/api/v1/health") return next();

		const authorization = c.req.header("authorization");
		if (!authorization) {
			return c.json({ error: "UNAUTHORIZED", message: "Missing bearer token" }, 401);
		}

		const spaceIndex = authorization.indexOf(" ");
		if (spaceIndex <= 0) {
			return c.json({ error: "UNAUTHORIZED", message: "Invalid bearer token" }, 401);
		}

		const scheme = authorization.slice(0, spaceIndex).toLowerCase();
		const token = authorization.slice(spaceIndex + 1).trim();
		if (scheme !== "bearer" || token.length === 0 || token !== authToken) {
			return c.json({ error: "UNAUTHORIZED", message: "Invalid bearer token" }, 401);
		}

		return next();
	});

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
	registerSubscriptionRoutes(app, manager);
	registerWebhookRoutes(app, webhookClient ?? null);
	registerDebugRoutes(app, manager, debugTracker);
	registerEventRoutes(app, manager, eventBus);
	registerInspectRoutes(app);

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
