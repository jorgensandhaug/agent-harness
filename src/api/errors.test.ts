import { describe, expect, it } from "bun:test";
import type { ManagerError } from "../session/manager.ts";
import { mapManagerError } from "./errors.ts";

describe("api/errors.mapManagerError", () => {
	it("maps all manager errors to stable HTTP status/body", () => {
		const cases: Array<{ input: ManagerError; expected: ReturnType<typeof mapManagerError> }> = [
			{
				input: { code: "PROJECT_NOT_FOUND", name: "proj" },
				expected: {
					status: 404,
					body: { error: "PROJECT_NOT_FOUND", message: "Project 'proj' not found" },
				},
			},
			{
				input: { code: "PROJECT_EXISTS", name: "proj" },
				expected: {
					status: 409,
					body: { error: "PROJECT_EXISTS", message: "Project 'proj' already exists" },
				},
			},
			{
				input: { code: "AGENT_NOT_FOUND", id: "a1", project: "proj" },
				expected: {
					status: 404,
					body: {
						error: "AGENT_NOT_FOUND",
						message: "Agent 'a1' not found in project 'proj'",
					},
				},
			},
			{
				input: { code: "UNKNOWN_PROVIDER", name: "x" },
				expected: {
					status: 400,
					body: { error: "INVALID_REQUEST", message: "Unknown provider 'x'" },
				},
			},
			{
				input: { code: "PROVIDER_DISABLED", name: "x" },
				expected: {
					status: 400,
					body: { error: "INVALID_REQUEST", message: "Provider 'x' is disabled" },
				},
			},
			{
				input: { code: "SUBSCRIPTION_NOT_FOUND", id: "sub-a" },
				expected: {
					status: 400,
					body: { error: "INVALID_REQUEST", message: "Subscription 'sub-a' not found" },
				},
			},
			{
				input: {
					code: "SUBSCRIPTION_PROVIDER_MISMATCH",
					id: "sub-a",
					provider: "codex",
					subscriptionProvider: "claude-code",
				},
				expected: {
					status: 400,
					body: {
						error: "INVALID_REQUEST",
						message: "Subscription 'sub-a' is for provider 'claude-code', not 'codex'",
					},
				},
			},
			{
				input: { code: "SUBSCRIPTION_INVALID", id: "sub-a", reason: "bad auth" },
				expected: {
					status: 400,
					body: {
						error: "INVALID_REQUEST",
						message: "Subscription 'sub-a' invalid: bad auth",
					},
				},
			},
			{
				input: { code: "TMUX_ERROR", message: "boom" },
				expected: {
					status: 500,
					body: { error: "TMUX_ERROR", message: "boom" },
				},
			},
		];

		for (const tc of cases) {
			expect(mapManagerError(tc.input)).toEqual(tc.expected);
		}
	});
});
