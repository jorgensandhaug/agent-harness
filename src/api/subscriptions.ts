import type { Hono } from "hono";
import type { Manager } from "../session/manager.ts";

export function registerSubscriptionRoutes(app: Hono, manager: Manager): void {
	app.get("/api/v1/subscriptions", async (c) => {
		const subscriptions = await manager.listSubscriptions();
		return c.json({ subscriptions });
	});
}
