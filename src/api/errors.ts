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
		case "TMUX_ERROR":
			return {
				status: 500,
				body: { error: "TMUX_ERROR", message: error.message },
			};
	}
}
