import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Manager } from "../session/manager.ts";
import { registerSubscriptionRoutes } from "./subscriptions.ts";

describe("api/subscriptions.route", () => {
	it("returns only subscriptions for allowed providers", async () => {
		const app = new Hono();
		const manager = {
			async listSubscriptions() {
				return [
					{
						id: "claude-max",
						model: "claude-3-7-sonnet-latest",
						subscription: { provider: "claude-code" },
					},
					{
						id: "codex-plus",
						model: "gpt-5-codex",
						subscription: { provider: "codex" },
					},
				];
			},
		} as unknown as Manager;

		registerSubscriptionRoutes(app, manager);

		const response = await app.fetch(new Request("http://localhost/api/v1/subscriptions"));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.subscriptions).toEqual([
			{
				id: "codex-plus",
				model: "gpt-5-codex",
				subscription: { provider: "codex" },
			},
		]);
	});
});
