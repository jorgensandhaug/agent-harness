export type AgentStatus = "starting" | "idle" | "processing" | "waiting_input" | "error" | "exited";

export type ApiProject = {
	name: string;
	cwd: string;
	tmuxSession: string;
	agentCount: number;
	callback?: {
		url: string;
		discordChannel?: string;
		sessionKey?: string;
	};
	createdAt: string;
};

export type ApiProjectAgentSummary = {
	id: string;
	provider: string;
	status: AgentStatus;
	tmuxTarget: string;
};

export type ApiAgentCallback = {
	url: string;
	discordChannel?: string;
	sessionKey?: string;
	extra?: Record<string, string>;
};

export type ApiAgent = {
	id: string;
	project: string;
	provider: string;
	status: AgentStatus;
	brief: string[];
	task: string;
	windowName: string;
	tmuxTarget: string;
	attachCommand: string;
	subscriptionId?: string;
	callback?: ApiAgentCallback;
	providerRuntimeDir?: string;
	providerSessionFile?: string;
	createdAt: string;
	lastActivity: string;
	lastCapturedOutput: string;
};

export type HealthResponse = {
	uptime: number;
	projects: number;
	agents: number;
	tmuxAvailable: boolean;
	version: string;
};

export type CreateProjectRequest = {
	name: string;
	cwd: string;
	callback?: {
		url: string;
		token?: string;
		discordChannel?: string;
		sessionKey?: string;
	};
};

export type UpdateProjectRequest = {
	callback: {
		url: string;
		token?: string;
		discordChannel?: string;
		sessionKey?: string;
	};
};

export type CreateAgentRequest = {
	provider: string;
	task: string;
	name?: string;
	model?: string;
	subscription?: string;
	callback?: {
		url: string;
		token?: string;
		discordChannel?: string;
		sessionKey?: string;
		extra?: Record<string, string>;
	};
};

export type SendInputRequest = {
	text: string;
};

export type WebhookTestRequest = {
	event?: "agent_completed" | "agent_error" | "agent_exited";
	project?: string;
	agentId?: string;
	provider?: string;
	status?: string;
	lastMessage?: string | null;
	url?: string;
	token?: string;
	discordChannel?: string;
	sessionKey?: string;
	extra?: Record<string, string>;
};

export type ProjectDetailResponse = {
	project: ApiProject;
	agents: ApiProjectAgentSummary[];
};

export type ApiAgentListItem = Record<string, unknown> & {
	id: string;
	provider?: string;
	status?: AgentStatus;
	tmuxTarget?: string;
	brief?: string[];
};

export type AgentGetResponse = Record<string, unknown> & {
	agent: Record<string, unknown>;
	status?: AgentStatus;
	lastOutput?: string;
};

export type AgentOutputResponse = {
	output: string;
	lines: number;
};

export type AgentMessagesResponse = Record<string, unknown> & {
	provider?: string;
	source?: string;
	messages?: Array<Record<string, unknown>>;
	lastAssistantMessage?: Record<string, unknown> | null;
	parseErrorCount?: number;
	warnings?: string[];
};

export type SubscriptionsListResponse = {
	subscriptions: Array<Record<string, unknown>>;
};

export type WebhookStatusResponse = Record<string, unknown>;
export type WebhookTestResponse = Record<string, unknown>;
export type WebhookProbeResponse = Record<string, unknown>;

export type ApiErrorBody = {
	error?: unknown;
	message?: unknown;
	[key: string]: unknown;
};

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly method: string;
	readonly url: string;
	readonly body: ApiErrorBody | string | null;

	constructor(params: {
		status: number;
		code: string;
		message: string;
		method: string;
		url: string;
		body: ApiErrorBody | string | null;
	}) {
		super(params.message);
		this.name = "ApiError";
		this.status = params.status;
		this.code = params.code;
		this.method = params.method;
		this.url = params.url;
		this.body = params.body;
	}
}

export class NetworkError extends Error {
	readonly method: string;
	readonly url: string;
	readonly causeValue: unknown;

	constructor(message: string, method: string, url: string, causeValue: unknown) {
		super(message);
		this.name = "NetworkError";
		this.method = method;
		this.url = url;
		this.causeValue = causeValue;
	}
}

export type SseFrame = {
	id?: string;
	event?: string;
	data: string;
};

export type RawApiRequest = {
	method: string;
	path: string;
	query?: Record<string, string | number | boolean | null | undefined>;
	headers?: Record<string, string>;
	body?: unknown;
	timeoutMs?: number;
};

export type RawApiResponse = {
	status: number;
	headers: Record<string, string>;
	contentType: string | null;
	json: unknown | null;
	text: string | null;
};

export type CliHttpClient = {
	health(): Promise<HealthResponse>;
	listProjects(): Promise<{ projects: ApiProject[] }>;
	createProject(input: CreateProjectRequest): Promise<{ project: ApiProject }>;
	updateProject(name: string, input: UpdateProjectRequest): Promise<{ project: ApiProject }>;
	getProject(name: string): Promise<ProjectDetailResponse>;
	deleteProject(name: string): Promise<void>;
	listAgents(project: string): Promise<{ agents: ApiAgentListItem[] }>;
	createAgent(
		project: string,
		input: CreateAgentRequest,
	): Promise<{ agent: Record<string, unknown> }>;
	getAgent(project: string, agentId: string): Promise<AgentGetResponse>;
	sendAgentInput(
		project: string,
		agentId: string,
		input: SendInputRequest,
	): Promise<{ delivered: boolean }>;
	getAgentOutput(project: string, agentId: string, lines?: number): Promise<AgentOutputResponse>;
	getAgentMessages(
		project: string,
		agentId: string,
		options?: { limit?: number; role?: "all" | "user" | "assistant" | "system" | "developer" },
	): Promise<AgentMessagesResponse>;
	getAgentLastMessage(project: string, agentId: string): Promise<Record<string, unknown>>;
	getAgentDebug(project: string, agentId: string): Promise<Record<string, unknown>>;
	abortAgent(project: string, agentId: string): Promise<{ sent: boolean }>;
	deleteAgent(project: string, agentId: string): Promise<void>;
	listSubscriptions(): Promise<SubscriptionsListResponse>;
	webhookStatus(): Promise<WebhookStatusResponse>;
	webhookTest(input?: WebhookTestRequest): Promise<WebhookTestResponse>;
	webhookProbe(baseUrl?: string): Promise<WebhookProbeResponse>;
	openProjectEvents(project: string, since?: string, signal?: AbortSignal): Promise<Response>;
	openAgentEvents(
		project: string,
		agentId: string,
		since?: string,
		signal?: AbortSignal,
	): Promise<Response>;
	rawRequest(input: RawApiRequest): Promise<RawApiResponse>;
};

type ClientOptions = {
	url: string;
	token?: string;
	compact?: boolean;
	timeoutMs?: number;
};

type RequestOptions = {
	query?: Record<string, string | number | boolean | null | undefined>;
	body?: unknown;
	headers?: Record<string, string>;
	compact?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
};

type PendingSseFrame = {
	id?: string;
	event?: string;
	dataLines: string[];
};

const DEFAULT_TIMEOUT_MS = 10000;

function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

function normalizeBaseUrl(url: string): string {
	const trimmed = url.trim();
	if (trimmed.length === 0) {
		throw new Error("Base URL is required");
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`Invalid base URL '${url}'`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported base URL protocol '${parsed.protocol}'`);
	}
	return trimTrailingSlashes(parsed.toString());
}

function ensurePath(path: string): string {
	if (path.startsWith("http://") || path.startsWith("https://")) {
		return path;
	}
	if (path.startsWith("/")) return path;
	return `/${path}`;
}

function shouldIncludeCompact(
	defaultCompact: boolean,
	compactOverride: boolean | undefined,
): boolean {
	if (compactOverride === undefined) return defaultCompact;
	return compactOverride;
}

function buildUrl(
	baseUrl: string,
	path: string,
	query?: Record<string, string | number | boolean | null | undefined>,
): string {
	const targetPath = ensurePath(path);
	const url =
		targetPath.startsWith("http://") || targetPath.startsWith("https://")
			? new URL(targetPath)
			: new URL(targetPath, `${baseUrl}/`);

	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value === null || value === undefined) continue;
			url.searchParams.set(key, String(value));
		}
	}
	return url.toString();
}

async function parseResponseBody(
	response: Response,
): Promise<{ json: unknown | null; text: string | null }> {
	const text = await response.text();
	if (text.length === 0) {
		return { json: null, text: null };
	}
	try {
		return { json: JSON.parse(text), text };
	} catch {
		return { json: null, text };
	}
}

function toApiErrorBody(value: unknown): ApiErrorBody | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as ApiErrorBody;
}

function createHeaders(token?: string, extra?: Record<string, string>): Headers {
	const headers = new Headers();
	headers.set("accept", "application/json");
	headers.set("user-agent", "agent-harness-cli");
	if (token && token.trim().length > 0) {
		headers.set("authorization", `Bearer ${token.trim()}`);
	}
	if (extra) {
		for (const [key, value] of Object.entries(extra)) {
			headers.set(key, value);
		}
	}
	return headers;
}

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || error.name === "TimeoutError";
}

async function request(
	baseUrl: string,
	token: string | undefined,
	defaultCompact: boolean,
	method: string,
	path: string,
	options: RequestOptions,
): Promise<Response> {
	const query = { ...(options.query ?? {}) };
	if (shouldIncludeCompact(defaultCompact, options.compact)) {
		query["compact"] = "1";
	}
	const url = buildUrl(baseUrl, path, query);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let timeoutSignal: AbortSignal | undefined;
	if (timeoutMs > 0) {
		timeoutSignal = AbortSignal.timeout(timeoutMs);
	}

	let signal: AbortSignal | undefined = undefined;
	if (timeoutSignal && options.signal) {
		signal = AbortSignal.any([timeoutSignal, options.signal]);
	} else {
		signal = timeoutSignal ?? options.signal;
	}

	const headers = createHeaders(token, options.headers);
	let body: string | undefined;
	if (options.body !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(options.body);
	}

	try {
		return await fetch(url, {
			method,
			headers,
			...(body !== undefined ? { body } : {}),
			...(signal ? { signal } : {}),
		});
	} catch (error) {
		if (isAbortError(error)) {
			throw new NetworkError(`Request timed out after ${timeoutMs}ms`, method, url, error);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new NetworkError(`Request failed: ${message}`, method, url, error);
	}
}

async function requestJson<T>(
	baseUrl: string,
	token: string | undefined,
	defaultCompact: boolean,
	method: string,
	path: string,
	options: RequestOptions = {},
): Promise<T> {
	const response = await request(baseUrl, token, defaultCompact, method, path, options);
	if (response.ok) {
		const { json, text } = await parseResponseBody(response);
		if (json !== null) {
			return json as T;
		}
		if (text === null) {
			return {} as T;
		}
		throw new NetworkError(
			"Expected JSON response but received plain text",
			method,
			response.url,
			text,
		);
	}

	const { json, text } = await parseResponseBody(response);
	const body = toApiErrorBody(json) ?? text;
	const code =
		(toApiErrorBody(json)?.error as string | undefined) ??
		(response.statusText && response.statusText.length > 0
			? response.statusText
			: `HTTP_${response.status}`);
	const message =
		(toApiErrorBody(json)?.message as string | undefined) ??
		(typeof body === "string" && body.trim().length > 0
			? body
			: `Request failed with status ${response.status}`);
	throw new ApiError({
		status: response.status,
		code,
		message,
		method,
		url: response.url,
		body,
	});
}

async function requestEmpty(
	baseUrl: string,
	token: string | undefined,
	defaultCompact: boolean,
	method: string,
	path: string,
	options: RequestOptions = {},
): Promise<void> {
	const response = await request(baseUrl, token, defaultCompact, method, path, options);
	if (response.ok) return;
	const { json, text } = await parseResponseBody(response);
	const body = toApiErrorBody(json) ?? text;
	const code =
		(toApiErrorBody(json)?.error as string | undefined) ??
		(response.statusText && response.statusText.length > 0
			? response.statusText
			: `HTTP_${response.status}`);
	const message =
		(toApiErrorBody(json)?.message as string | undefined) ??
		(typeof body === "string" && body.trim().length > 0
			? body
			: `Request failed with status ${response.status}`);
	throw new ApiError({
		status: response.status,
		code,
		message,
		method,
		url: response.url,
		body,
	});
}

function dispatchPendingFrame(pending: PendingSseFrame): SseFrame | null {
	if (!pending.id && !pending.event && pending.dataLines.length === 0) {
		return null;
	}
	return {
		...(pending.id ? { id: pending.id } : {}),
		...(pending.event ? { event: pending.event } : {}),
		data: pending.dataLines.join("\n"),
	};
}

function resetPendingFrame(): PendingSseFrame {
	return { dataLines: [] };
}

function parseSseLine(line: string, pending: PendingSseFrame): void {
	if (line.startsWith(":")) return;
	const separatorIndex = line.indexOf(":");
	const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
	let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
	if (value.startsWith(" ")) value = value.slice(1);

	switch (field) {
		case "event":
			pending.event = value;
			return;
		case "id":
			pending.id = value;
			return;
		case "data":
			pending.dataLines.push(value);
			return;
		case "retry":
			return;
		default:
			return;
	}
}

function normalizeLine(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export async function* readSseFrames(response: Response): AsyncGenerator<SseFrame> {
	if (!response.body) {
		throw new NetworkError("Missing response body for SSE stream", "GET", response.url, null);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let pending = resetPendingFrame();

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			const line = normalizeLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
			if (line.length === 0) {
				const frame = dispatchPendingFrame(pending);
				pending = resetPendingFrame();
				if (frame) yield frame;
				continue;
			}
			parseSseLine(line, pending);
		}
	}

	buffer += decoder.decode();
	if (buffer.length > 0) {
		for (const lineRaw of buffer.split(/\n/)) {
			const line = normalizeLine(lineRaw);
			if (line.length === 0) {
				const frame = dispatchPendingFrame(pending);
				pending = resetPendingFrame();
				if (frame) yield frame;
				continue;
			}
			parseSseLine(line, pending);
		}
	}

	const tailFrame = dispatchPendingFrame(pending);
	if (tailFrame) {
		yield tailFrame;
	}
}

export function createHttpClient(options: ClientOptions): CliHttpClient {
	const baseUrl = normalizeBaseUrl(options.url);
	const token = options.token?.trim();
	const defaultCompact = options.compact ?? false;
	const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		health() {
			return requestJson<HealthResponse>(baseUrl, token, false, "GET", "/api/v1/health", {
				timeoutMs: defaultTimeoutMs,
			});
		},
		listProjects() {
			return requestJson<{ projects: ApiProject[] }>(
				baseUrl,
				token,
				defaultCompact,
				"GET",
				"/api/v1/projects",
				{ timeoutMs: defaultTimeoutMs, compact: false },
			);
		},
		createProject(input) {
			return requestJson<{ project: ApiProject }>(
				baseUrl,
				token,
				defaultCompact,
				"POST",
				"/api/v1/projects",
				{ body: input, timeoutMs: defaultTimeoutMs, compact: false },
			);
		},
		updateProject(name, input) {
			const encoded = encodeURIComponent(name);
			return requestJson<{ project: ApiProject }>(
				baseUrl,
				token,
				defaultCompact,
				"PATCH",
				`/api/v1/projects/${encoded}`,
				{ body: input, timeoutMs: defaultTimeoutMs, compact: false },
			);
		},
		getProject(name) {
			const encoded = encodeURIComponent(name);
			return requestJson<ProjectDetailResponse>(
				baseUrl,
				token,
				defaultCompact,
				"GET",
				`/api/v1/projects/${encoded}`,
				{ timeoutMs: defaultTimeoutMs, compact: false },
			);
		},
		deleteProject(name) {
			const encoded = encodeURIComponent(name);
			return requestEmpty(baseUrl, token, defaultCompact, "DELETE", `/api/v1/projects/${encoded}`, {
				timeoutMs: defaultTimeoutMs,
				compact: false,
			});
		},
		listAgents(project) {
			const encoded = encodeURIComponent(project);
				return requestJson<{ agents: ApiAgentListItem[] }>(
					baseUrl,
					token,
					defaultCompact,
					"GET",
					`/api/v1/projects/${encoded}/agents`,
					{ timeoutMs: defaultTimeoutMs },
				);
			},
		createAgent(project, input) {
			const encoded = encodeURIComponent(project);
				return requestJson<{ agent: Record<string, unknown> }>(
					baseUrl,
					token,
					defaultCompact,
					"POST",
					`/api/v1/projects/${encoded}/agents`,
					{ body: input, timeoutMs: defaultTimeoutMs },
				);
			},
		getAgent(project, agentId) {
			const encodedProject = encodeURIComponent(project);
			const encodedAgent = encodeURIComponent(agentId);
				return requestJson<AgentGetResponse>(
					baseUrl,
					token,
					defaultCompact,
					"GET",
					`/api/v1/projects/${encodedProject}/agents/${encodedAgent}`,
					{ timeoutMs: defaultTimeoutMs },
				);
			},
		sendAgentInput(project, agentId, input) {
			const encodedProject = encodeURIComponent(project);
			const encodedAgent = encodeURIComponent(agentId);
			return requestJson<{ delivered: boolean }>(
				baseUrl,
				token,
				defaultCompact,
				"POST",
				`/api/v1/projects/${encodedProject}/agents/${encodedAgent}/input`,
				{ body: input, timeoutMs: defaultTimeoutMs, compact: false },
			);
		},
		getAgentOutput(project, agentId, lines) {
			const encodedProject = encodeURIComponent(project);
			const encodedAgent = encodeURIComponent(agentId);
			return requestJson<AgentOutputResponse>(
				baseUrl,
				token,
				defaultCompact,
				"GET",
				`/api/v1/projects/${encodedProject}/agents/${encodedAgent}/output`,
				{
					query: {
						...(lines !== undefined ? { lines } : {}),
					},
					timeoutMs: defaultTimeoutMs,
					compact: false,
				},
			);
		},
		getAgentMessages(project, agentId, options) {
			const encodedProject = encodeURIComponent(project);
			const encodedAgent = encodeURIComponent(agentId);
			return requestJson<AgentMessagesResponse>(
				baseUrl,
				token,
				defaultCompact,
				"GET",
				`/api/v1/projects/${encodedProject}/agents/${encodedAgent}/messages`,
				{
					query: {
						...(options?.limit !== undefined ? { limit: options.limit } : {}),
						...(options?.role ? { role: options.role } : {}),
					},
					timeoutMs: defaultTimeoutMs,
					compact: false,
				},
			);
		},
		getAgentLastMessage(project, agentId) {
			const encodedProject = encodeURIComponent(project);
			const encodedAgent = encodeURIComponent(agentId);
				return requestJson<Record<string, unknown>>(
					baseUrl,
					token,
					defaultCompact,
					"GET",
					`/api/v1/projects/${encodedProject}/agents/${encodedAgent}/messages/last`,
					{ timeoutMs: defaultTimeoutMs },
				);
			},
		getAgentDebug(project, agentId) {
			const encodedProject = encodeURIComponent(project);
			const encodedAgent = encodeURIComponent(agentId);
			return requestJson<Record<string, unknown>>(
				baseUrl,
				token,
				defaultCompact,
				"GET",
				`/api/v1/projects/${encodedProject}/agents/${encodedAgent}/debug`,
				{ timeoutMs: defaultTimeoutMs, compact: false },
			);
		},
		abortAgent(project, agentId) {
			const encodedProject = encodeURIComponent(project);
			const encodedAgent = encodeURIComponent(agentId);
			return requestJson<{ sent: boolean }>(
				baseUrl,
				token,
				defaultCompact,
				"POST",
				`/api/v1/projects/${encodedProject}/agents/${encodedAgent}/abort`,
				{ timeoutMs: defaultTimeoutMs, compact: false },
			);
		},
		deleteAgent(project, agentId) {
			const encodedProject = encodeURIComponent(project);
			const encodedAgent = encodeURIComponent(agentId);
			return requestEmpty(
				baseUrl,
				token,
				defaultCompact,
				"DELETE",
				`/api/v1/projects/${encodedProject}/agents/${encodedAgent}`,
				{ timeoutMs: defaultTimeoutMs, compact: false },
			);
		},
		listSubscriptions() {
			return requestJson<SubscriptionsListResponse>(
				baseUrl,
				token,
				defaultCompact,
				"GET",
				"/api/v1/subscriptions",
				{ timeoutMs: defaultTimeoutMs, compact: false },
			);
		},
		webhookStatus() {
			return requestJson<WebhookStatusResponse>(
				baseUrl,
				token,
				defaultCompact,
				"GET",
				"/api/v1/webhook/status",
				{ timeoutMs: defaultTimeoutMs, compact: false },
			);
		},
		webhookTest(input) {
			return requestJson<WebhookTestResponse>(
				baseUrl,
				token,
				defaultCompact,
				"POST",
				"/api/v1/webhook/test",
				{
					...(input ? { body: input } : {}),
					timeoutMs: defaultTimeoutMs,
					compact: false,
				},
			);
		},
		webhookProbe(baseUrlOverride) {
			return requestJson<WebhookProbeResponse>(
				baseUrl,
				token,
				defaultCompact,
				"POST",
				"/api/v1/webhook/probe-receiver",
				{
					...(baseUrlOverride ? { body: { baseUrl: baseUrlOverride } } : {}),
					timeoutMs: defaultTimeoutMs,
					compact: false,
				},
			);
		},
		async openProjectEvents(project, since, signal) {
			const encodedProject = encodeURIComponent(project);
			const response = await request(
				baseUrl,
				token,
				defaultCompact,
				"GET",
				`/api/v1/projects/${encodedProject}/events`,
				{
					query: { ...(since ? { since } : {}) },
					headers: { accept: "text/event-stream" },
					timeoutMs: 0,
					...(signal ? { signal } : {}),
					compact: false,
				},
			);
			if (!response.ok) {
				const { json, text } = await parseResponseBody(response);
				const body = toApiErrorBody(json) ?? text;
				const code =
					(toApiErrorBody(json)?.error as string | undefined) ??
					(response.statusText && response.statusText.length > 0
						? response.statusText
						: `HTTP_${response.status}`);
				const message =
					(toApiErrorBody(json)?.message as string | undefined) ??
					(typeof body === "string" && body.trim().length > 0
						? body
						: `Request failed with status ${response.status}`);
				throw new ApiError({
					status: response.status,
					code,
					message,
					method: "GET",
					url: response.url,
					body,
				});
			}
			return response;
		},
		async openAgentEvents(project, agentId, since, signal) {
			const encodedProject = encodeURIComponent(project);
			const encodedAgent = encodeURIComponent(agentId);
			const response = await request(
				baseUrl,
				token,
				defaultCompact,
				"GET",
				`/api/v1/projects/${encodedProject}/agents/${encodedAgent}/events`,
				{
					query: { ...(since ? { since } : {}) },
					headers: { accept: "text/event-stream" },
					timeoutMs: 0,
					...(signal ? { signal } : {}),
					compact: false,
				},
			);
			if (!response.ok) {
				const { json, text } = await parseResponseBody(response);
				const body = toApiErrorBody(json) ?? text;
				const code =
					(toApiErrorBody(json)?.error as string | undefined) ??
					(response.statusText && response.statusText.length > 0
						? response.statusText
						: `HTTP_${response.status}`);
				const message =
					(toApiErrorBody(json)?.message as string | undefined) ??
					(typeof body === "string" && body.trim().length > 0
						? body
						: `Request failed with status ${response.status}`);
				throw new ApiError({
					status: response.status,
					code,
					message,
					method: "GET",
					url: response.url,
					body,
				});
			}
			return response;
		},
		async rawRequest(input) {
			const method = input.method.toUpperCase();
			const response = await request(baseUrl, token, false, method, input.path, {
				...(input.query ? { query: input.query } : {}),
				...(input.headers ? { headers: input.headers } : {}),
				body: input.body,
				timeoutMs: input.timeoutMs ?? defaultTimeoutMs,
				compact: false,
			});
			const headers: Record<string, string> = {};
			for (const [key, value] of response.headers.entries()) {
				headers[key] = value;
			}
			const { json, text } = await parseResponseBody(response);
			return {
				status: response.status,
				headers,
				contentType: response.headers.get("content-type"),
				json,
				text,
			};
		},
	};
}
