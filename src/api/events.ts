import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../events/bus.ts";
import type { Manager } from "../session/manager.ts";
import type { EventId } from "../types.ts";

export function registerEventRoutes(app: Hono, manager: Manager, eventBus: EventBus): void {
	// SSE for all agents in a project
	app.get("/api/v1/projects/:name/events", (c) => {
		const projectName = c.req.param("name");
		const since = c.req.query("since") as EventId | undefined;

		// Verify project exists
		const projectResult = manager.getProject(projectName);
		if (!projectResult.ok) {
			return c.json(
				{ error: "PROJECT_NOT_FOUND", message: `Project '${projectName}' not found` },
				404,
			);
		}

		return streamSSE(c, async (stream) => {
			const filter = { project: projectName };

			// Send any missed events since reconnect
			if (since) {
				const missed = eventBus.since(since, filter);
				for (const event of missed) {
					await stream.writeSSE({
						id: event.id,
						event: event.type,
						data: JSON.stringify(event),
					});
				}
			}

			// Subscribe to new events
			let closed = false;
			const unsubscribe = eventBus.subscribe(filter, (event) => {
				if (closed) return;
				stream
					.writeSSE({
						id: event.id,
						event: event.type,
						data: JSON.stringify(event),
					})
					.catch(() => {
						closed = true;
					});
			});

			// Keep connection alive with heartbeat
			const heartbeat = setInterval(() => {
				if (closed) {
					clearInterval(heartbeat);
					return;
				}
				stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => {
					closed = true;
				});
			}, 15000);

			// Wait for client disconnect
			stream.onAbort(() => {
				closed = true;
				clearInterval(heartbeat);
				unsubscribe();
			});

			// Keep stream open — wait indefinitely until abort
			while (!closed) {
				await Bun.sleep(1000);
			}
		});
	});

	// SSE for a single agent
	app.get("/api/v1/projects/:name/agents/:agentId/events", (c) => {
		const projectName = c.req.param("name");
		const agentId = c.req.param("agentId");
		const since = c.req.query("since") as EventId | undefined;

		// Verify agent exists
		const agentResult = manager.getAgent(projectName, agentId);
		if (!agentResult.ok) {
			return c.json(
				{
					error: "AGENT_NOT_FOUND",
					message: `Agent '${agentId}' not found in project '${projectName}'`,
				},
				404,
			);
		}

		return streamSSE(c, async (stream) => {
			const filter = { project: projectName, agentId };

			// Send missed events
			if (since) {
				const missed = eventBus.since(since, filter);
				for (const event of missed) {
					await stream.writeSSE({
						id: event.id,
						event: event.type,
						data: JSON.stringify(event),
					});
				}
			}

			// Subscribe
			let closed = false;
			const unsubscribe = eventBus.subscribe(filter, (event) => {
				if (closed) return;
				stream
					.writeSSE({
						id: event.id,
						event: event.type,
						data: JSON.stringify(event),
					})
					.catch(() => {
						closed = true;
					});
			});

			const heartbeat = setInterval(() => {
				if (closed) {
					clearInterval(heartbeat);
					return;
				}
				stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => {
					closed = true;
				});
			}, 15000);

			stream.onAbort(() => {
				closed = true;
				clearInterval(heartbeat);
				unsubscribe();
			});

			while (!closed) {
				await Bun.sleep(1000);
			}
		});
	});
}
