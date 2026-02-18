import type { Hono } from "hono";
import { z } from "zod";
import type { Manager } from "../session/manager.ts";
import { readAgentMessages } from "../session/messages.ts";
import { mapManagerError } from "./errors.ts";

const CreateAgentBody = z.object({
	provider: z.string().min(1),
	task: z.string().min(1),
	model: z.string().optional(),
	subscription: z.string().min(1).optional(),
	callback: z
		.object({
			url: z.string().url(),
			token: z.string().min(1).optional(),
			discordChannel: z.string().min(1).optional(),
			sessionKey: z.string().min(1).optional(),
			extra: z.record(z.string()).optional(),
		})
		.optional(),
});

const SendInputBody = z.object({
	text: z.string().min(1),
});

const OutputQuery = z.object({
	lines: z.coerce.number().int().min(1).max(10000).optional(),
});

const MessagesQuery = z.object({
	limit: z.coerce.number().int().min(1).max(500).optional(),
	role: z.enum(["all", "user", "assistant", "system", "developer"]).optional(),
});

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
					message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
				},
				400,
			);
		}

		const result = await manager.createAgent(
			projectName,
			parsed.data.provider,
			parsed.data.task,
			parsed.data.model,
			parsed.data.subscription,
			parsed.data.callback,
		);
		if (!result.ok) {
			const mapped = mapManagerError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.json({ agent: result.value }, 201);
	});

	// List agents
	app.get(P, (c) => {
		const projectName = c.req.param("name");
		const result = manager.listAgents(projectName);
		if (!result.ok) {
			const mapped = mapManagerError(result.error);
			return c.json(mapped.body, mapped.status);
		}
		return c.json({ agents: result.value });
	});

	// Get agent — returns full recent output (not truncated)
	app.get(`${P}/:id`, (c) => {
		const projectName = c.req.param("name");
		const agentId = c.req.param("id");
		const result = manager.getAgent(projectName, agentId);
		if (!result.ok) {
			const mapped = mapManagerError(result.error);
			return c.json(mapped.body, mapped.status);
		}
		const agent = result.value;
		return c.json({
			agent,
			status: agent.status,
			lastOutput: agent.lastCapturedOutput,
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
					message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
				},
				400,
			);
		}

		const result = await manager.sendInput(projectName, agentId, parsed.data.text);
		if (!result.ok) {
			const mapped = mapManagerError(result.error);
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
			const mapped = mapManagerError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.json(result.value);
	});

	// Get structured messages from provider internals (no tmux pane parsing)
	app.get(`${P}/:id/messages`, async (c) => {
		const projectName = c.req.param("name");
		const agentId = c.req.param("id");
		const query = MessagesQuery.safeParse({
			limit: c.req.query("limit"),
			role: c.req.query("role"),
		});
		if (!query.success) {
			return c.json(
				{
					error: "INVALID_REQUEST",
					message: query.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
				},
				400,
			);
		}

		const agentResult = manager.getAgent(projectName, agentId);
		if (!agentResult.ok) {
			const mapped = mapManagerError(agentResult.error);
			return c.json(mapped.body, mapped.status);
		}

		const result = await readAgentMessages(agentResult.value, {
			...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
			...(query.data.role !== undefined ? { role: query.data.role } : {}),
		});
		return c.json(result);
	});

	// Get the latest assistant message from provider internals
	app.get(`${P}/:id/messages/last`, async (c) => {
		const projectName = c.req.param("name");
		const agentId = c.req.param("id");

		const agentResult = manager.getAgent(projectName, agentId);
		if (!agentResult.ok) {
			const mapped = mapManagerError(agentResult.error);
			return c.json(mapped.body, mapped.status);
		}

		const result = await readAgentMessages(agentResult.value, {
			role: "all",
			limit: 1,
		});
		return c.json({
			provider: result.provider,
			source: result.source,
			lastAssistantMessage: result.lastAssistantMessage,
			parseErrorCount: result.parseErrorCount,
			warnings: result.warnings,
		});
	});

	// Abort agent
	app.post(`${P}/:id/abort`, async (c) => {
		const projectName = c.req.param("name");
		const agentId = c.req.param("id");

		const result = await manager.abortAgent(projectName, agentId);
		if (!result.ok) {
			const mapped = mapManagerError(result.error);
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
			const mapped = mapManagerError(result.error);
			return c.json(mapped.body, mapped.status);
		}

		return c.body(null, 204);
	});
}
