import type { Hono } from "hono";
import type { DebugTracker } from "../debug/tracker.ts";
import type { Manager } from "../session/manager.ts";
import { mapManagerError } from "./errors.ts";

const P = "/api/v1/projects/:name/agents/:id/debug";

export function registerDebugRoutes(app: Hono, manager: Manager, debugTracker: DebugTracker): void {
	app.get(P, (c) => {
		const projectName = c.req.param("name");
		const agentId = c.req.param("id");
		const agentResult = manager.getAgent(projectName, agentId);
		if (!agentResult.ok) {
			const mapped = mapManagerError(agentResult.error);
			return c.json(mapped.body, mapped.status);
		}

		const debugKey = `${agentResult.value.project}:${agentResult.value.id}`;
		const debug = debugTracker.getAgentDebug(debugKey);
		if (!debug) {
			return c.json(
				{
					error: "NOT_FOUND",
					message: "Debug state not available for this agent",
				},
				404,
			);
		}

		return c.json({ debug });
	});
}
