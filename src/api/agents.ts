import type { Hono } from "hono";
import { z } from "zod";
import type { Manager } from "../session/manager.ts";

const CreateAgentBody = z.object({
	provider: z.string().min(1),
	task: z.string().min(1),
	model: z.string().optional(),
});

const SendInputBody = z.object({
	text: z.string().min(1),
});

const OutputQuery = z.object({
	lines: z.coerce.number().int().min(1).max(10000).optional(),
});

function mapError(error: {
	code: string;
	name?: string;
	id?: string;
	project?: string;
	message?: string;
}) {
	switch (error.code) {
		case "PROJECT_NOT_FOUND":
			return {
				status: 404 as const,
				body: { error: "PROJECT_NOT_FOUND", message: `Project '${error.name}' not found` },
			};
		case "AGENT_NOT_FOUND":
			return {
				status: 404 as const,
				body: {
					error: "AGENT_NOT_FOUND",
					message: `Agent '${error.id}' not found in project '${error.project}'`,
				},
			};
		case "UNKNOWN_PROVIDER":
			return {
				status: 400 as const,
				body: { error: "INVALID_REQUEST", message: `Unknown provider '${error.name}'` },
			};
		case "PROVIDER_DISABLED":
			return {
				status: 400 as const,
				body: { error: "INVALID_REQUEST", message: `Provider '${error.name}' is disabled` },
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

const P = "/api/v1/projects/:name/agents";

export function registerAgentRoutes(app: Hono, manager: Manager): void {
	// Create agent
	app.post(P, async (c) => {
		const projectName = c.req.param("name");
		const rawBody = await c.req.json().catch(() => null);
		const parsed = CreateAgentBody.safeParse(rawBody);
		if (!parsed.success) {
			return c.json(
				{
					error: "INVALID_REQUEST",
					message: parsed.error.issues
						.map((i) => `${i.path.join(".")}: ${i.message}`)
						.join("; "),
				},
				400,
			);
		}

		const result = await manager.createAgent(
			projectName,
			parsed.data.provider,
			parsed.data.task,
			parsed.data.model,
		);
		if (!result.ok) {
			const mapped = mapError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.json({ agent: result.value }, 201);
	});

	// List agents
	app.get(P, (c) => {
		const projectName = c.req.param("name");
		const result = manager.listAgents(projectName);
		if (!result.ok) {
			const mapped = mapError(result.error);
			return c.json(mapped.body, mapped.status);
		}
		return c.json({ agents: result.value });
	});

	// Get agent
	app.get(`${P}/:id`, (c) => {
		const projectName = c.req.param("name");
		const agentId = c.req.param("id");
		const result = manager.getAgent(projectName, agentId);
		if (!result.ok) {
			const mapped = mapError(result.error);
			return c.json(mapped.body, mapped.status);
		}
		const agent = result.value;
		return c.json({
			agent,
			status: agent.status,
			lastOutput: agent.lastCapturedOutput.slice(-2000),
		});
	});

	// Send input
	app.post(`${P}/:id/input`, async (c) => {
		const projectName = c.req.param("name");
		const agentId = c.req.param("id");
		const rawBody = await c.req.json().catch(() => null);
		const parsed = SendInputBody.safeParse(rawBody);
		if (!parsed.success) {
			return c.json(
				{
					error: "INVALID_REQUEST",
					message: parsed.error.issues
						.map((i) => `${i.path.join(".")}: ${i.message}`)
						.join("; "),
				},
				400,
			);
		}

		const result = await manager.sendInput(projectName, agentId, parsed.data.text);
		if (!result.ok) {
			const mapped = mapError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.json({ delivered: true }, 202);
	});

	// Get output
	app.get(`${P}/:id/output`, async (c) => {
		const projectName = c.req.param("name");
		const agentId = c.req.param("id");
		const query = OutputQuery.safeParse({ lines: c.req.query("lines") });
		const lines = query.success ? query.data.lines : undefined;

		const result = await manager.getAgentOutput(projectName, agentId, lines);
		if (!result.ok) {
			const mapped = mapError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.json(result.value);
	});

	// Abort agent
	app.post(`${P}/:id/abort`, async (c) => {
		const projectName = c.req.param("name");
		const agentId = c.req.param("id");

		const result = await manager.abortAgent(projectName, agentId);
		if (!result.ok) {
			const mapped = mapError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.json({ sent: true }, 202);
	});

	// Delete agent
	app.delete(`${P}/:id`, async (c) => {
		const projectName = c.req.param("name");
		const agentId = c.req.param("id");

		const result = await manager.deleteAgent(projectName, agentId);
		if (!result.ok) {
			const mapped = mapError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.body(null, 204);
	});
}
