import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../events/bus.ts";
import type { Manager } from "../session/manager.ts";
import { isValidEventId } from "../types.ts";

type StreamState = {
	closed: boolean;
	heartbeat: ReturnType<typeof setInterval> | null;
	unsubscribe: (() => void) | null;
};

function cleanupStream(state: StreamState): void {
	if (state.closed) return;
	state.closed = true;
	if (state.heartbeat) {
		clearInterval(state.heartbeat);
		state.heartbeat = null;
	}
	if (state.unsubscribe) {
		state.unsubscribe();
		state.unsubscribe = null;
	}
}

function newStreamState(): StreamState {
	return { closed: false, heartbeat: null, unsubscribe: null };
}

export function registerEventRoutes(app: Hono, manager: Manager, eventBus: EventBus): void {
	// SSE for all agents in a project
	app.get("/api/v1/projects/:name/events", (c) => {
		const projectName = c.req.param("name");
		const sinceRaw = c.req.query("since");
		const since = sinceRaw && isValidEventId(sinceRaw) ? sinceRaw : undefined;

		const projectResult = manager.getProject(projectName);
		if (!projectResult.ok) {
			return c.json(
				{ error: "PROJECT_NOT_FOUND", message: `Project '${projectName}' not found` },
				404,
			);
		}

		return streamSSE(c, async (stream) => {
			const filter = { project: projectName };
			const state = newStreamState();

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

			state.unsubscribe = eventBus.subscribe(filter, (event) => {
				if (state.closed) return;
				stream
					.writeSSE({ id: event.id, event: event.type, data: JSON.stringify(event) })
					.catch(() => cleanupStream(state));
			});

			state.heartbeat = setInterval(() => {
				if (state.closed) {
					cleanupStream(state);
					return;
				}
				stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => cleanupStream(state));
			}, 15000);

			stream.onAbort(() => cleanupStream(state));

			while (!state.closed) {
				await Bun.sleep(1000);
			}
		});
	});

	// SSE for a single agent
	app.get("/api/v1/projects/:name/agents/:id/events", (c) => {
		const projectName = c.req.param("name");
		const agentId = c.req.param("id");
		const sinceRaw = c.req.query("since");
		const since = sinceRaw && isValidEventId(sinceRaw) ? sinceRaw : undefined;

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
			const state = newStreamState();

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

			state.unsubscribe = eventBus.subscribe(filter, (event) => {
				if (state.closed) return;
				stream
					.writeSSE({ id: event.id, event: event.type, data: JSON.stringify(event) })
					.catch(() => cleanupStream(state));
			});

			state.heartbeat = setInterval(() => {
				if (state.closed) {
					cleanupStream(state);
					return;
				}
				stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => cleanupStream(state));
			}, 15000);

			stream.onAbort(() => cleanupStream(state));

			while (!state.closed) {
				await Bun.sleep(1000);
			}
		});
	});
}
