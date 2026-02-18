import type { Hono } from "hono";
import { z } from "zod";
import type { Manager } from "../session/manager.ts";
import { mapManagerError } from "./errors.ts";

const CreateProjectBody = z.object({
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z0-9_-]+$/, "Name must be alphanumeric with dashes/underscores"),
	cwd: z.string().min(1),
});

export function registerProjectRoutes(app: Hono, manager: Manager): void {
	app.post("/api/v1/projects", async (c) => {
		const rawBody = await c.req.json().catch(() => null);
		const parsed = CreateProjectBody.safeParse(rawBody);
		if (!parsed.success) {
			return c.json(
				{
					error: "INVALID_REQUEST",
					message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
				},
				400,
			);
		}

		const result = await manager.createProject(parsed.data.name, parsed.data.cwd);
		if (!result.ok) {
			const mapped = mapManagerError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.json({ project: result.value }, 201);
	});

	app.get("/api/v1/projects", (c) => {
		const projects = manager.listProjects();
		return c.json({ projects });
	});

	app.get("/api/v1/projects/:name", (c) => {
		const name = c.req.param("name");
		const projectResult = manager.getProject(name);
		if (!projectResult.ok) {
			const mapped = mapManagerError(projectResult.error);
			return c.json(mapped.body, mapped.status);
		}

		const agentsResult = manager.listAgents(name);
		const agents = agentsResult.ok
			? agentsResult.value.map((a) => ({
					id: a.id,
					provider: a.provider,
					status: a.status,
					tmuxTarget: a.tmuxTarget,
				}))
			: [];

		return c.json({ project: projectResult.value, agents });
	});

	app.delete("/api/v1/projects/:name", async (c) => {
		const name = c.req.param("name");
		const result = await manager.deleteProject(name);
		if (!result.ok) {
			const mapped = mapManagerError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.body(null, 204);
	});
}
