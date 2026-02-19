import type { Hono } from "hono";
import { z } from "zod";
import type { Manager } from "../session/manager.ts";
import type { Project } from "../session/types.ts";
import { mapManagerError } from "./errors.ts";

const CallbackBody = z.object({
	url: z.string().url(),
	token: z.string().min(1).optional(),
	discordChannel: z.string().min(1).optional(),
	sessionKey: z.string().min(1).optional(),
});

const CreateProjectBody = z.object({
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z0-9_-]+$/, "Name must be alphanumeric with dashes/underscores"),
	cwd: z.string().min(1),
	callback: CallbackBody.optional(),
});

const UpdateProjectBody = z.object({
	cwd: z.string().min(1).optional(),
	callback: CallbackBody.optional(),
});

function redactProjectForApi(project: Project): Project {
	const callback = project.callback;
	if (!callback) return project;
	return {
		...project,
		callback: {
			url: callback.url,
			...(callback.discordChannel ? { discordChannel: callback.discordChannel } : {}),
			...(callback.sessionKey ? { sessionKey: callback.sessionKey } : {}),
		},
	};
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

		const result = await manager.createProject(
			parsed.data.name,
			parsed.data.cwd,
			parsed.data.callback,
		);
		if (!result.ok) {
			const mapped = mapManagerError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.json({ project: redactProjectForApi(result.value) }, 201);
	});

	app.patch("/api/v1/projects/:name", async (c) => {
		const name = c.req.param("name");
		const rawBody = await c.req.json().catch(() => null);
		const parsed = UpdateProjectBody.safeParse(rawBody);
		if (!parsed.success) {
			return c.json(
				{
					error: "INVALID_REQUEST",
					message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
				},
				400,
			);
		}
		if (!parsed.data.callback && !parsed.data.cwd) {
			return c.json(
				{
					error: "INVALID_REQUEST",
					message: "At least one of cwd or callback is required",
				},
				400,
			);
		}

		const result = await manager.updateProject(name, {
			...(parsed.data.cwd !== undefined ? { cwd: parsed.data.cwd } : {}),
			...(parsed.data.callback ? { callback: parsed.data.callback } : {}),
		});
		if (!result.ok) {
			const mapped = mapManagerError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.json({ project: redactProjectForApi(result.value) });
	});

	app.get("/api/v1/projects", (c) => {
		const projects = manager.listProjects().map((project) => redactProjectForApi(project));
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

		return c.json({ project: redactProjectForApi(projectResult.value), agents });
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
