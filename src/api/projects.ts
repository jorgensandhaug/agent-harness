import type { Hono } from "hono";
import { z } from "zod";
import type { Manager } from "../session/manager.ts";

const CreateProjectBody = z.object({
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z0-9_-]+$/, "Name must be alphanumeric with dashes/underscores"),
	cwd: z.string().min(1),
});

function mapError(error: { code: string; name?: string; message?: string }) {
	switch (error.code) {
		case "PROJECT_NOT_FOUND":
			return {
				status: 404 as const,
				body: { error: "PROJECT_NOT_FOUND", message: `Project '${error.name}' not found` },
			};
		case "PROJECT_EXISTS":
			return {
				status: 409 as const,
				body: { error: "PROJECT_EXISTS", message: `Project '${error.name}' already exists` },
			};
		case "TMUX_ERROR":
			return {
				status: 500 as const,
				body: { error: "TMUX_ERROR", message: error.message ?? "tmux error" },
			};
		default:
			return {
				status: 500 as const,
				body: { error: "INTERNAL_ERROR", message: "Unknown error" },
			};
	}
}

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
			const mapped = mapError(result.error);
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
			const mapped = mapError(projectResult.error);
			return c.json(mapped.body, mapped.status);
		}

		const agentsResult = manager.listAgents(name);
		const agents = agentsResult.ok
			? agentsResult.value.map((a) => ({ id: a.id, provider: a.provider, status: a.status }))
			: [];

		return c.json({ project: projectResult.value, agents });
	});

	app.delete("/api/v1/projects/:name", async (c) => {
		const name = c.req.param("name");
		const result = await manager.deleteProject(name);
		if (!result.ok) {
			const mapped = mapError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.body(null, 204);
	});
}
