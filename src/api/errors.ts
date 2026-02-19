import type { ManagerError } from "../session/manager.ts";

type MappedError = {
	status: 400 | 404 | 409 | 500;
	body: { error: string; message: string };
};

export function mapManagerError(error: ManagerError): MappedError {
	switch (error.code) {
		case "PROJECT_NOT_FOUND":
			return {
				status: 404,
				body: { error: "PROJECT_NOT_FOUND", message: `Project '${error.name}' not found` },
			};
		case "PROJECT_EXISTS":
			return {
				status: 409,
				body: { error: "PROJECT_EXISTS", message: `Project '${error.name}' already exists` },
			};
		case "AGENT_NOT_FOUND":
			return {
				status: 404,
				body: {
					error: "AGENT_NOT_FOUND",
					message: `Agent '${error.id}' not found in project '${error.project}'`,
				},
			};
		case "AGENT_NAME_INVALID":
			return {
				status: 400,
				body: {
					error: "INVALID_REQUEST",
					message: `Invalid agent name '${error.name}': ${error.reason}`,
				},
			};
		case "NAME_CONFLICT":
			return {
				status: 409,
				body: {
					error: "NAME_CONFLICT",
					message: `Agent name '${error.name}' already exists in project '${error.project}'`,
				},
			};
		case "UNKNOWN_PROVIDER":
			return {
				status: 400,
				body: { error: "INVALID_REQUEST", message: `Unknown provider '${error.name}'` },
			};
		case "PROVIDER_DISABLED":
			return {
				status: 400,
				body: { error: "INVALID_REQUEST", message: `Provider '${error.name}' is disabled` },
			};
		case "SUBSCRIPTION_NOT_FOUND":
			return {
				status: 400,
				body: { error: "INVALID_REQUEST", message: `Subscription '${error.id}' not found` },
			};
		case "SUBSCRIPTION_PROVIDER_MISMATCH":
			return {
				status: 400,
				body: {
					error: "INVALID_REQUEST",
					message: `Subscription '${error.id}' is for provider '${error.subscriptionProvider}', not '${error.provider}'`,
				},
			};
		case "SUBSCRIPTION_INVALID":
			return {
				status: 400,
				body: {
					error: "INVALID_REQUEST",
					message: `Subscription '${error.id}' invalid: ${error.reason}`,
				},
			};
		case "TMUX_ERROR":
			return {
				status: 500,
				body: { error: "TMUX_ERROR", message: error.message },
			};
	}
}
