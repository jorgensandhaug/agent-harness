import type { Hono } from "hono";
import { isProviderAllowed } from "../providers/allowed.ts";
import type { Manager } from "../session/manager.ts";

export function registerSubscriptionRoutes(app: Hono, manager: Manager): void {
	app.get("/api/v1/subscriptions", async (c) => {
		const subscriptions = await manager.listSubscriptions();
		const filtered = subscriptions.filter((subscription) =>
			isProviderAllowed(subscription.subscription.provider),
		);
		return c.json({ subscriptions: filtered });
	});
}
