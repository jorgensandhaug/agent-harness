import { randomUUID } from "node:crypto";
import {
	access,
	chmod,
	copyFile,
	lstat,
	mkdir,
	readFile,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { HarnessConfig, SubscriptionConfig } from "../config.ts";
import type { DebugTracker } from "../debug/tracker.ts";
import type { EventBus } from "../events/bus.ts";
import type { StatusChangeSource } from "../events/types.ts";
import { log } from "../log.ts";
import { getProvider } from "../providers/registry.ts";
import type { AgentStatus } from "../providers/types.ts";
import { summarizeSubscription } from "../subscriptions/credentials.ts";
import { discoverSubscriptions } from "../subscriptions/discovery.ts";
import * as tmux from "../tmux/client.ts";
import {
	type AgentId,
	type ProjectName,
	type Result,
	agentId,
	err,
	isValidAgentId,
	newAgentId,
	newEventId,
	normalizeAgentIdInput,
	ok,
	projectName,
} from "../types.ts";
import { formatAttachCommand } from "./attach.ts";
import type { Store } from "./store.ts";
import type { Agent, AgentCallback, Project } from "./types.ts";

export type ManagerError =
	| { code: "PROJECT_NOT_FOUND"; name: string }
	| { code: "PROJECT_EXISTS"; name: string }
	| { code: "AGENT_NOT_FOUND"; id: string; project: string }
	| { code: "AGENT_NAME_INVALID"; name: string; reason: string }
	| { code: "NAME_CONFLICT"; name: string; project: string }
	| { code: "UNKNOWN_PROVIDER"; name: string }
	| { code: "PROVIDER_DISABLED"; name: string }
	| { code: "SUBSCRIPTION_NOT_FOUND"; id: string }
	| {
			code: "SUBSCRIPTION_PROVIDER_MISMATCH";
			id: string;
			provider: string;
			subscriptionProvider: string;
	  }
	| { code: "SUBSCRIPTION_INVALID"; id: string; reason: string }
	| { code: "TMUX_ERROR"; message: string };

export function createManager(
	config: HarnessConfig,
	store: Store,
	eventBus: EventBus,
	debugTracker?: DebugTracker,
) {
	const TRUST_PROMPT_CONFIRM_PATTERN = /Enter to confirm/i;
	const TRUST_PROMPT_CONTEXT_PATTERN = /Quick safety check|trust this folder|Accessing workspace/i;
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const envInitialDelayRaw = process.env["HARNESS_INITIAL_TASK_DELAY_MS"];
	const envInitialDelay =
		envInitialDelayRaw !== undefined ? Number.parseInt(envInitialDelayRaw, 10) : null;
	// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
	const envReadyTimeoutRaw = process.env["HARNESS_INITIAL_TASK_READY_TIMEOUT_MS"];
	const envReadyTimeout =
		envReadyTimeoutRaw !== undefined ? Number.parseInt(envReadyTimeoutRaw, 10) : null;
	const READY_POLL_INTERVAL_MS = 200;
	const DEFAULT_CODEX_HOME = resolve(join(homedir(), ".codex"));
	const DEFAULT_PI_HOME = resolve(join(homedir(), ".pi", "agent"));
	const CLAUDE_AUTH_ENV_KEYS = [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN",
	];
	const CODEX_AUTH_ENV_KEYS = ["OPENAI_API_KEY", "CODEX_API_KEY"];

	function mergedPath(parts: readonly string[]): string {
		const out: string[] = [];
		const seen = new Set<string>();
		for (const raw of parts) {
			const value = raw.trim();
			if (value.length === 0) continue;
			if (seen.has(value)) continue;
			seen.add(value);
			out.push(value);
		}
		return out.join(":");
	}

	function defaultAgentPath(): string {
		const home = homedir();
		const inherited =
			// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
			process.env["PATH"]?.split(":") ?? [];
		const userBins = [
			`${home}/.local/bin`,
			`${home}/.bun/bin`,
			`${home}/.npm-global/bin`,
			`${home}/.cargo/bin`,
		];
		return mergedPath([
			...userBins,
			...inherited,
			"/run/current-system/sw/bin",
			"/usr/bin",
			"/bin",
		]);
	}
	type ResolvedSubscription = {
		id: string;
		subscription: SubscriptionConfig;
		source: "configured" | "discovered";
		locator: {
			kind: "sourceDir" | "tokenFile";
			path: string;
		};
		provenance: Record<string, unknown>;
	};

	function subscriptionLocator(subscription: SubscriptionConfig): {
		kind: "sourceDir" | "tokenFile";
		path: string;
	} {
		if (subscription.provider === "claude-code") {
			if (typeof subscription.sourceDir === "string" && subscription.sourceDir.trim().length > 0) {
				return { kind: "sourceDir", path: resolve(subscription.sourceDir) };
			}
			if (typeof subscription.tokenFile === "string" && subscription.tokenFile.trim().length > 0) {
				return { kind: "tokenFile", path: resolve(subscription.tokenFile) };
			}
			return { kind: "sourceDir", path: "(missing)" };
		}
		return { kind: "sourceDir", path: resolve(subscription.sourceDir) };
	}

	function subscriptionSignature(subscription: SubscriptionConfig): string {
		const locator = subscriptionLocator(subscription);
		return `${subscription.provider}:${locator.kind}:${locator.path}`;
	}

	async function resolveSubscriptions(): Promise<readonly ResolvedSubscription[]> {
		const configured: ResolvedSubscription[] = Object.entries(config.subscriptions).map(
			([id, subscription]) => ({
				id,
				subscription,
				source: "configured",
				locator: subscriptionLocator(subscription),
				provenance: {
					source: "configured",
					configKey: id,
				},
			}),
		);
		const merged = [...configured];
		const usedIds = new Set(merged.map((entry) => entry.id));
		const configuredSignatures = new Set(
			configured.map((entry) => subscriptionSignature(entry.subscription)),
		);
		const discovery = config.subscriptionDiscovery;
		if (discovery?.enabled === true) {
			const discovered = await discoverSubscriptions(discovery);
			for (const entry of discovered) {
				const signature = subscriptionSignature(entry.subscription);
				if (configuredSignatures.has(signature)) continue;

				let id = entry.id;
				if (usedIds.has(id)) {
					let counter = 2;
					while (usedIds.has(`${entry.id}-${counter}`)) {
						counter += 1;
					}
					id = `${entry.id}-${counter}`;
				}
				usedIds.add(id);
				merged.push({
					id,
					subscription: entry.subscription,
					source: "discovered",
					locator: subscriptionLocator(entry.subscription),
					provenance: entry.provenance,
				});
			}
		}

		return merged.sort((a, b) => a.id.localeCompare(b.id));
	}

	async function ensureSecureDir(path: string): Promise<void> {
		await mkdir(path, { recursive: true, mode: 0o700 });
		try {
			await chmod(path, 0o700);
		} catch {
			// best effort
		}
	}

	async function copyRequiredFile(sourcePath: string, targetPath: string): Promise<void> {
		await access(sourcePath);
		await copyFile(sourcePath, targetPath);
		try {
			await chmod(targetPath, 0o600);
		} catch {
			// best effort
		}
	}

	function withUnsetEnvKeys(
		existing: readonly string[],
		keys: readonly string[],
	): readonly string[] {
		return Array.from(new Set([...existing, ...keys]));
	}

	function escapedTomlString(value: string): string {
		return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
	}

	function upsertForcedWorkspaceId(content: string, workspaceId: string): string {
		const line = `forced_chatgpt_workspace_id = \"${escapedTomlString(workspaceId)}\"`;
		if (/^\s*forced_chatgpt_workspace_id\s*=/m.test(content)) {
			return content.replace(/^\s*forced_chatgpt_workspace_id\s*=.*$/m, line);
		}
		const trimmed = content.trimEnd();
		return trimmed.length > 0 ? `${trimmed}\n${line}\n` : `${line}\n`;
	}

	async function symlinkIfPresent(sourcePath: string, linkPath: string): Promise<void> {
		try {
			await access(sourcePath);
		} catch {
			return;
		}

		try {
			await lstat(linkPath);
			return;
		} catch {
			// continue
		}

		try {
			await symlink(sourcePath, linkPath);
		} catch (error) {
			log.warn("failed to create codex runtime symlink", {
				sourcePath,
				linkPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async function prepareClaudeSubscriptionEnv(
		env: Record<string, string>,
		subscription: Extract<SubscriptionConfig, { provider: "claude-code" }>,
	): Promise<{
		runtimeDir?: string;
		env: Record<string, string>;
		unsetEnv: readonly string[];
	}> {
		const claudeProfileEnvKeys = Object.keys(process.env).filter((key) =>
			key.startsWith("CLAUDE_PROFILE_"),
		);
		const unsetBase = withUnsetEnvKeys([], [...CLAUDE_AUTH_ENV_KEYS, ...claudeProfileEnvKeys]);

		if (typeof subscription.sourceDir === "string" && subscription.sourceDir.trim().length > 0) {
			const runtimeDir = resolve(subscription.sourceDir);
			const defaultClaudeDir = resolve(join(homedir(), ".claude"));
			if (runtimeDir === defaultClaudeDir) {
				// Keep default Claude behavior to avoid first-run onboarding flows tied to explicit CLAUDE_CONFIG_DIR.
				return {
					runtimeDir,
					env,
					unsetEnv: withUnsetEnvKeys(unsetBase, ["CLAUDE_CONFIG_DIR"]),
				};
			}
			return {
				runtimeDir,
				env: { ...env, CLAUDE_CONFIG_DIR: runtimeDir },
				unsetEnv: unsetBase,
			};
		}

		if (typeof subscription.tokenFile === "string" && subscription.tokenFile.trim().length > 0) {
			const tokenRaw = await Bun.file(subscription.tokenFile).text();
			const token = tokenRaw.trim();
			if (token.length === 0) {
				throw new Error(`tokenFile is empty: ${subscription.tokenFile}`);
			}
			return {
				env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: token },
				unsetEnv: withUnsetEnvKeys(unsetBase, ["CLAUDE_CONFIG_DIR"]),
			};
		}

		throw new Error("claude subscription missing sourceDir/tokenFile");
	}

	async function prepareCodexRuntimeDir(
		project: ProjectName,
		id: AgentId,
		env: Record<string, string>,
	): Promise<{ runtimeDir: string; env: Record<string, string> }> {
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const existing = env["CODEX_HOME"];
		if (existing && existing.trim().length > 0) {
			return { runtimeDir: existing, env };
		}

		const runtimeDir = resolve(config.logDir, "codex", project, id);
		await ensureSecureDir(runtimeDir);
		await symlinkIfPresent(join(DEFAULT_CODEX_HOME, "auth.json"), join(runtimeDir, "auth.json"));
		await symlinkIfPresent(
			join(DEFAULT_CODEX_HOME, "config.toml"),
			join(runtimeDir, "config.toml"),
		);

		return {
			runtimeDir,
			env: { ...env, CODEX_HOME: runtimeDir },
		};
	}

	async function prepareCodexSubscriptionRuntimeDir(
		project: ProjectName,
		id: AgentId,
		env: Record<string, string>,
		subscription: Extract<SubscriptionConfig, { provider: "codex" }>,
	): Promise<{
		runtimeDir: string;
		env: Record<string, string>;
		unsetEnv: readonly string[];
	}> {
		const runtimeDir = resolve(config.logDir, "codex", project, id);
		await ensureSecureDir(runtimeDir);

		await copyRequiredFile(
			join(subscription.sourceDir, "auth.json"),
			join(runtimeDir, "auth.json"),
		);

		const sourceConfigToml = join(subscription.sourceDir, "config.toml");
		const runtimeConfigToml = join(runtimeDir, "config.toml");
		let sourceTomlExists = false;
		try {
			await access(sourceConfigToml);
			sourceTomlExists = true;
		} catch {
			sourceTomlExists = false;
		}

		if (sourceTomlExists) {
			await copyRequiredFile(sourceConfigToml, runtimeConfigToml);
		}

		if (subscription.enforceWorkspace && subscription.workspaceId) {
			let content = "";
			if (sourceTomlExists) {
				try {
					content = await readFile(runtimeConfigToml, "utf8");
				} catch {
					content = "";
				}
			}
			const patched = upsertForcedWorkspaceId(content, subscription.workspaceId);
			await writeFile(runtimeConfigToml, patched);
			try {
				await chmod(runtimeConfigToml, 0o600);
			} catch {
				// best effort
			}
		}

		return {
			runtimeDir,
			env: { ...env, CODEX_HOME: runtimeDir },
			unsetEnv: withUnsetEnvKeys([], CODEX_AUTH_ENV_KEYS),
		};
	}

	async function preparePiRuntimeDir(
		project: ProjectName,
		id: AgentId,
		env: Record<string, string>,
	): Promise<{ runtimeDir: string; env: Record<string, string> }> {
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const existing = env["PI_CODING_AGENT_DIR"];
		if (existing && existing.trim().length > 0) {
			return { runtimeDir: existing, env };
		}

		const runtimeDir = resolve(config.logDir, "pi", project, id);
		await ensureSecureDir(runtimeDir);
		await symlinkIfPresent(join(DEFAULT_PI_HOME, "auth.json"), join(runtimeDir, "auth.json"));

		return {
			runtimeDir,
			env: { ...env, PI_CODING_AGENT_DIR: runtimeDir },
		};
	}

	async function prepareOpenCodeRuntime(
		project: ProjectName,
		id: AgentId,
		env: Record<string, string>,
	): Promise<{ dataHome: string; env: Record<string, string> }> {
		// biome-ignore lint/complexity/useLiteralKeys: index signature + noPropertyAccessFromIndexSignature
		const existing = env["XDG_DATA_HOME"];
		if (existing && existing.trim().length > 0) {
			return { dataHome: existing, env };
		}

		const runtimeRoot = resolve(config.logDir, "opencode", project, id);
		const dataHome = join(runtimeRoot, "xdg-data");
		const stateHome = join(runtimeRoot, "xdg-state");
		const cacheHome = join(runtimeRoot, "xdg-cache");
		await ensureSecureDir(dataHome);
		await ensureSecureDir(stateHome);
		await ensureSecureDir(cacheHome);

		return {
			dataHome,
			env: {
				...env,
				XDG_DATA_HOME: dataHome,
				XDG_STATE_HOME: stateHome,
				XDG_CACHE_HOME: cacheHome,
			},
		};
	}

	function claudeProjectStorageDir(cwd: string): string {
		const normalized = resolve(cwd).replaceAll("/", "-");
		return join(homedir(), ".claude", "projects", normalized);
	}

	function transitionAgentStatus(
		projectNameStr: string,
		agent: Agent,
		nextStatus: AgentStatus,
		source: StatusChangeSource,
	): void {
		if (agent.status === nextStatus) return;
		const from = agent.status;
		store.updateAgentStatus(agent.project, agent.id, nextStatus);
		eventBus.emit({
			id: newEventId(),
			ts: new Date().toISOString(),
			project: projectNameStr,
			agentId: agent.id,
			type: "status_changed",
			from,
			to: nextStatus,
			source,
		});
	}

	function initialTaskDelayMs(providerName: string): number {
		if (envInitialDelay !== null && Number.isFinite(envInitialDelay) && envInitialDelay >= 0) {
			return envInitialDelay;
		}
		// Claude Code startup can take multiple seconds before input is accepted.
		return providerName === "claude-code" ? 7000 : 2000;
	}

	function initialTaskReadyTimeoutMs(providerName: string): number {
		if (envReadyTimeout !== null && Number.isFinite(envReadyTimeout) && envReadyTimeout >= 0) {
			return envReadyTimeout;
		}
		if (providerName === "claude-code") return 10000;
		if (providerName === "codex") return 1500;
		return 0;
	}

	function shouldProbeStartupReadiness(providerName: string): boolean {
		return providerName === "claude-code" || providerName === "codex";
	}

	function shouldPassInitialTaskViaCli(providerName: string): boolean {
		return providerName === "claude-code" || providerName === "codex";
	}

	function looksLikeStartupTrustPrompt(capturedOutput: string): boolean {
		const lines = capturedOutput
			.split("\n")
			.map((line) => line.replace(/\r$/, ""))
			.filter((line) => line.trim().length > 0);
		if (lines.length === 0) return false;

		const bottom = lines.slice(-8).join("\n");
		const nearBottom = lines.slice(-2).join("\n");
		return (
			TRUST_PROMPT_CONFIRM_PATTERN.test(nearBottom) && TRUST_PROMPT_CONTEXT_PATTERN.test(bottom)
		);
	}

	async function dismissStartupTrustPrompt(
		target: string,
		agentIdForLog: string,
		providerNameForLog: string,
	): Promise<void> {
		const deadline = Date.now() + 2500;
		let attempts = 0;
		while (Date.now() < deadline && attempts < 8) {
			const captureResult = await tmux.capturePane(target, 120);
			if (!captureResult.ok) return;
			if (!looksLikeStartupTrustPrompt(captureResult.value)) return;
			const confirmResult = await tmux.sendKeys(target, "Enter");
			if (!confirmResult.ok) {
				log.warn("failed to auto-confirm startup trust prompt", {
					agentId: agentIdForLog,
					provider: providerNameForLog,
					error: JSON.stringify(confirmResult.error),
				});
				return;
			}
			attempts++;
			await Bun.sleep(120);
		}
	}

	function codexFollowupPasteSettleMs(): number {
		// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
		const raw = process.env["HARNESS_CODEX_FOLLOWUP_PASTE_SETTLE_MS"];
		if (raw !== undefined) {
			const parsed = Number.parseInt(raw, 10);
			if (Number.isFinite(parsed) && parsed >= 0) return parsed;
		}
		return 2000;
	}

	async function sendAgentInput(
		target: string,
		providerName: string,
		text: string,
		phase: "initial" | "followup",
	) {
		if (phase === "followup" && providerName === "codex") {
			// Codex follow-up inputs are always sent as explicit paste -> settle -> Enter.
			const pasteResult = await tmux.pasteInput(target, text);
			if (!pasteResult.ok) return pasteResult;
			await Bun.sleep(codexFollowupPasteSettleMs());
			return tmux.sendKeys(target, "Enter");
		}

		return tmux.sendInput(target, text);
	}

	function tmuxSessionName(name: ProjectName): string {
		return `${config.tmuxPrefix}-${name}`;
	}

	function debugAgentKey(project: ProjectName, id: AgentId): string {
		return `${project}:${id}`;
	}

	function projectNameFromSession(sessionName: string): ProjectName | null {
		const prefix = `${config.tmuxPrefix}-`;
		if (!sessionName.startsWith(prefix)) return null;
		const rawName = sessionName.slice(prefix.length).trim();
		if (rawName.length === 0) return null;
		return projectName(rawName);
	}

	function createdAtFromEpochSeconds(epochSeconds: number): string {
		if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) {
			return new Date().toISOString();
		}
		return new Date(epochSeconds * 1000).toISOString();
	}

	function normalizedProviderPrefix(providerName: string): string {
		const normalized = providerName
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-+|-+$/g, "");
		const compact = normalized.length > 0 ? normalized : "agent";
		const sliced = compact.slice(0, 22).replace(/-+$/g, "");
		return sliced.length > 0 ? sliced : "agent";
	}

	function unquote(value: string): string {
		if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
			return value.slice(1, -1).replaceAll(`'"'"'`, "'");
		}
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
			return value.slice(1, -1);
		}
		return value;
	}

	function envVarFromStartCommand(startCommand: string, name: string): string | null {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = startCommand.match(new RegExp(`${escaped}=('(?:[^']*)'|"(?:[^"]*)"|\\S+)`));
		if (!match?.[1]) return null;
		const value = unquote(match[1].trim());
		return value.length > 0 ? value : null;
	}

	function claudeSessionIdFromStartCommand(startCommand: string): string | null {
		const match = startCommand.match(/--session-id\s+([0-9a-fA-F-]{36})/);
		return match?.[1] ?? null;
	}

	function providerFromProcessCommand(command: string): string | null {
		const normalized = command.trim().toLowerCase();
		if (normalized.length === 0) return null;
		const commandBase = basename(normalized);
		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const configuredBase = basename(providerConfig.command.trim().toLowerCase());
			if (
				configuredBase.length > 0 &&
				(normalized === configuredBase || commandBase === configuredBase)
			) {
				return providerName;
			}
		}
		return null;
	}

	function providerFromStartCommand(startCommand: string): string | null {
		const normalized = startCommand.trim().toLowerCase();
		if (normalized.length === 0) return null;
		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const configuredBase = basename(providerConfig.command.trim().toLowerCase());
			if (configuredBase.length === 0) continue;
			const escaped = configuredBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (new RegExp(`(^|\\s|/)${escaped}(\\s|$|'|")`).test(normalized)) {
				return providerName;
			}
		}
		return null;
	}

	function inferProviderName(
		windowName: string,
		currentCommand: string | null,
		startCommand: string | null,
	): string | null {
		if (currentCommand) {
			const fromCurrent = providerFromProcessCommand(currentCommand);
			if (fromCurrent) return fromCurrent;
		}
		if (startCommand) {
			const fromStart = providerFromStartCommand(startCommand);
			if (fromStart) return fromStart;
		}
		for (const providerName of Object.keys(config.providers)) {
			const prefix = `${normalizedProviderPrefix(providerName)}-`;
			if (windowName.startsWith(prefix)) {
				return providerName;
			}
		}
		return null;
	}

	async function rehydrateProjectsFromTmux(): Promise<void> {
		let sessionsResult = await tmux.listSessions(config.tmuxPrefix);
		for (let attempt = 1; !sessionsResult.ok && attempt <= 4; attempt += 1) {
			await Bun.sleep(150 * attempt);
			sessionsResult = await tmux.listSessions(config.tmuxPrefix);
		}
		if (!sessionsResult.ok) {
			log.warn("failed to list tmux sessions for project rehydrate", {
				error: JSON.stringify(sessionsResult.error),
			});
			return;
		}

		const existingBySession = new Set(store.listProjects().map((project) => project.tmuxSession));
		let recovered = 0;

		for (const session of sessionsResult.value) {
			if (existingBySession.has(session.name)) continue;
			const name = projectNameFromSession(session.name);
			if (!name) continue;

			const project: Project = {
				name,
				cwd: session.path || ".",
				tmuxSession: session.name,
				agentCount: 0,
				createdAt: createdAtFromEpochSeconds(session.createdAt),
			};
			store.addProject(project);
			existingBySession.add(session.name);
			recovered += 1;
		}

		if (recovered > 0) {
			log.info("projects rehydrated from tmux sessions", { recovered });
		}
	}

	async function rehydrateAgentsFromTmux(): Promise<void> {
		let recovered = 0;
		for (const project of store.listProjects()) {
			const windowsResult = await tmux.listWindows(project.tmuxSession);
			if (!windowsResult.ok) {
				log.warn("failed to list tmux windows for agent rehydrate", {
					session: project.tmuxSession,
					error: JSON.stringify(windowsResult.error),
				});
				continue;
			}

			const existing = new Set(store.listAgents(project.name).map((agent) => agent.id as string));
			for (const window of windowsResult.value) {
				const idRaw = window.name.trim();
				if (!isValidAgentId(idRaw)) continue;
				if (existing.has(idRaw)) continue;

				const id = agentId(idRaw);
				const target = `${project.tmuxSession}:${window.name}`;
				const paneDeadResult = await tmux.getPaneVar(target, "pane_dead");
				const paneCurrentResult = await tmux.getPaneVar(target, "pane_current_command");
				const paneStartResult = await tmux.getPaneVar(target, "pane_start_command");
				const providerName = inferProviderName(
					window.name,
					paneCurrentResult.ok ? paneCurrentResult.value : null,
					paneStartResult.ok ? paneStartResult.value : null,
				);
				if (!providerName) {
					log.warn("skipping tmux window rehydrate; provider unknown", {
						session: project.tmuxSession,
						window: window.name,
					});
					continue;
				}

				const providerResult = getProvider(providerName);
				if (!providerResult.ok) {
					log.warn("skipping tmux window rehydrate; provider unavailable", {
						providerName,
						session: project.tmuxSession,
						window: window.name,
					});
					continue;
				}

				const captureResult = await tmux.capturePane(target, config.captureLines);
				const output = captureResult.ok ? captureResult.value : "";
				let status: AgentStatus = "starting";
				if (paneDeadResult.ok && paneDeadResult.value === "1") {
					status = "exited";
				} else if (captureResult.ok) {
					status = providerResult.value.parseStatus(output);
				}

				const now = new Date().toISOString();
				const startCommand = paneStartResult.ok ? paneStartResult.value : "";
				const claudeSessionId = claudeSessionIdFromStartCommand(startCommand);
				const claudeSessionFile = claudeSessionId
					? join(claudeProjectStorageDir(project.cwd), `${claudeSessionId}.jsonl`)
					: null;
				const codexRuntimeDir = envVarFromStartCommand(startCommand, "CODEX_HOME");
				const piRuntimeDir = envVarFromStartCommand(startCommand, "PI_CODING_AGENT_DIR");
				const opencodeDataHome = envVarFromStartCommand(startCommand, "XDG_DATA_HOME");

				const agent: Agent = {
					id,
					project: project.name,
					provider: providerName,
					status,
					brief: [],
					task: "",
					windowName: window.name,
					tmuxTarget: target,
					attachCommand: formatAttachCommand(target),
					...(providerName === "claude-code" && claudeSessionFile
						? { providerSessionFile: claudeSessionFile }
						: {}),
					...(providerName === "codex" && codexRuntimeDir
						? { providerRuntimeDir: codexRuntimeDir }
						: {}),
					...(providerName === "pi" && piRuntimeDir ? { providerRuntimeDir: piRuntimeDir } : {}),
					...(providerName === "opencode" && opencodeDataHome
						? { providerRuntimeDir: opencodeDataHome }
						: {}),
					createdAt: now,
					lastActivity: now,
					lastCapturedOutput: output,
				};

				store.addAgent(agent);
				existing.add(idRaw);
				debugTracker?.ensureAgent(debugAgentKey(agent.project, id));
				recovered += 1;
			}
		}

		if (recovered > 0) {
			log.info("agents rehydrated from tmux windows", { recovered });
		}
	}

	// --- Projects ---

	async function createProject(
		name: string,
		cwd: string,
		callback?: AgentCallback,
	): Promise<Result<Project, ManagerError>> {
		const pName = projectName(name);

		if (store.getProject(pName)) {
			return err({ code: "PROJECT_EXISTS", name });
		}

		const sessionName = tmuxSessionName(pName);
		const sessionResult = await tmux.createSession(sessionName, cwd);
		if (!sessionResult.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to create tmux session: ${JSON.stringify(sessionResult.error)}`,
			});
		}

		const project: Project = {
			name: pName,
			cwd,
			tmuxSession: sessionName,
			agentCount: 0,
			...(callback ? { callback } : {}),
			createdAt: new Date().toISOString(),
		};

		store.addProject(project);
		log.info("project created", { name, session: sessionName });
		return ok(project);
	}

	function getProject(name: string): Result<Project, ManagerError> {
		const project = store.getProject(projectName(name));
		if (!project) {
			return err({ code: "PROJECT_NOT_FOUND", name });
		}
		return ok(project);
	}

	function listProjects(): readonly Project[] {
		return store.listProjects();
	}

	function updateProject(
		name: string,
		update: {
			callback: AgentCallback;
		},
	): Result<Project, ManagerError> {
		const pName = projectName(name);
		const project = store.getProject(pName);
		if (!project) {
			return err({ code: "PROJECT_NOT_FOUND", name });
		}

		store.updateProjectCallback(pName, update.callback);
		return ok(project);
	}

	async function listSubscriptions() {
		const entries = await resolveSubscriptions();
		const summaries = await Promise.all(
			entries.map(async (entry) => ({
				...(await summarizeSubscription(entry.id, entry.subscription)),
				source: entry.source,
				locator: entry.locator,
				subscription: entry.subscription,
				provenance: entry.provenance,
			})),
		);
		return summaries.sort((a, b) => a.id.localeCompare(b.id));
	}

	async function deleteProject(name: string): Promise<Result<void, ManagerError>> {
		const pName = projectName(name);
		const project = store.getProject(pName);
		if (!project) {
			return err({ code: "PROJECT_NOT_FOUND", name });
		}

		// Kill tmux session — propagate failure
		const killResult = await tmux.killSession(project.tmuxSession);
		if (!killResult.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to kill session '${project.tmuxSession}': ${JSON.stringify(killResult.error)}`,
			});
		}

		for (const agent of store.listAgents(pName)) {
			debugTracker?.removeAgent(debugAgentKey(agent.project, agent.id));
		}

		store.removeProject(pName);
		log.info("project deleted", { name });
		return ok(undefined);
	}

	// --- Agents ---

	async function createAgent(
		projectNameStr: string,
		providerName: string,
		task: string,
		model?: string,
		subscriptionId?: string,
		callback?: AgentCallback,
		name?: string,
	): Promise<Result<Agent, ManagerError>> {
		const pName = projectName(projectNameStr);
		const project = store.getProject(pName);
		if (!project) {
			return err({ code: "PROJECT_NOT_FOUND", name: projectNameStr });
		}

		const providerResult = getProvider(providerName);
		if (!providerResult.ok) {
			return err({ code: "UNKNOWN_PROVIDER", name: providerName });
		}
		const provider = providerResult.value;

		// Get provider config from harness config
		const providerConfig = config.providers[providerName];
		if (!providerConfig) {
			return err({ code: "UNKNOWN_PROVIDER", name: providerName });
		}
		if (!providerConfig.enabled) {
			return err({ code: "PROVIDER_DISABLED", name: providerName });
		}

		let subscription: SubscriptionConfig | undefined;
		if (subscriptionId !== undefined) {
			const available = await resolveSubscriptions();
			const selected = available.find((entry) => entry.id === subscriptionId);
			if (!selected) {
				return err({ code: "SUBSCRIPTION_NOT_FOUND", id: subscriptionId });
			}
			if (selected.subscription.provider !== providerName) {
				return err({
					code: "SUBSCRIPTION_PROVIDER_MISMATCH",
					id: subscriptionId,
					provider: providerName,
					subscriptionProvider: selected.subscription.provider,
				});
			}
			const summary = await summarizeSubscription(subscriptionId, selected.subscription);
			if (!summary.valid) {
				return err({
					code: "SUBSCRIPTION_INVALID",
					id: subscriptionId,
					reason: summary.reason ?? "unknown validation error",
				});
			}
			subscription = selected.subscription;
		}

		// Override model if specified
		const effectiveConfig = model ? { ...providerConfig, model } : providerConfig;
		const existingAgentNames = new Set(store.listAgents(pName).map((agent) => agent.id as string));
		let id: AgentId;
		if (name !== undefined) {
			const normalizedName = normalizeAgentIdInput(name);
			if (!isValidAgentId(normalizedName)) {
				return err({
					code: "AGENT_NAME_INVALID",
					name,
					reason: "must be 3-40 chars of lowercase a-z, 0-9, or hyphen",
				});
			}
			if (existingAgentNames.has(normalizedName)) {
				return err({ code: "NAME_CONFLICT", name: normalizedName, project: projectNameStr });
			}
			id = agentId(normalizedName);
		} else {
			id = newAgentId(providerName, existingAgentNames);
		}
		const wName = id;
		let cmd = [...provider.buildCommand(effectiveConfig)];
		const formattedInitialTask = provider.formatInput(task);
		const initialTaskViaCli =
			shouldPassInitialTaskViaCli(providerName) && formattedInitialTask.trim().length > 0;
		let env = provider.buildEnv(effectiveConfig);
		let unsetEnv: readonly string[] = [];
		let providerRuntimeDir: string | undefined;
		let providerSessionFile: string | undefined;
		if (providerName === "claude-code") {
			const sessionId = randomUUID();
			cmd = [...cmd, "--session-id", sessionId];
			providerSessionFile = join(claudeProjectStorageDir(project.cwd), `${sessionId}.jsonl`);
			if (subscription?.provider === "claude-code") {
				try {
					const prepared = await prepareClaudeSubscriptionEnv(env, subscription);
					env = prepared.env;
					if (prepared.runtimeDir) {
						providerRuntimeDir = prepared.runtimeDir;
					}
					unsetEnv = withUnsetEnvKeys(unsetEnv, prepared.unsetEnv);
				} catch (error) {
					return err({
						code: "SUBSCRIPTION_INVALID",
						id: subscriptionId ?? "unknown",
						reason: `failed to apply claude subscription: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
			}
		}
		if (providerName === "codex") {
			try {
				if (subscription?.provider === "codex") {
					const prepared = await prepareCodexSubscriptionRuntimeDir(pName, id, env, subscription);
					env = prepared.env;
					providerRuntimeDir = prepared.runtimeDir;
					unsetEnv = withUnsetEnvKeys(unsetEnv, prepared.unsetEnv);
				} else {
					const prepared = await prepareCodexRuntimeDir(pName, id, env);
					env = prepared.env;
					providerRuntimeDir = prepared.runtimeDir;
				}
			} catch (error) {
				if (subscription) {
					return err({
						code: "SUBSCRIPTION_INVALID",
						id: subscriptionId ?? "unknown",
						reason: `failed to materialize codex credentials: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
				log.warn("failed to initialize codex runtime dir; using default codex home", {
					agentId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (providerName === "pi") {
			try {
				const prepared = await preparePiRuntimeDir(pName, id, env);
				env = prepared.env;
				providerRuntimeDir = prepared.runtimeDir;
			} catch (error) {
				log.warn("failed to initialize pi runtime dir; using default pi home", {
					agentId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (providerName === "opencode") {
			try {
				const prepared = await prepareOpenCodeRuntime(pName, id, env);
				env = prepared.env;
				providerRuntimeDir = prepared.dataHome;
			} catch (error) {
				log.warn("failed to initialize opencode runtime dir; using default xdg data home", {
					agentId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const pathForAgent = defaultAgentPath();
		// Ensure provider binaries (claude/codex/etc) are resolvable in tmux panes even under systemd.
		env = {
			...env,
			PATH: mergedPath([
				pathForAgent,
				// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
				env["PATH"] ?? "",
			]),
		};
		if (initialTaskViaCli) {
			cmd = [...cmd, formattedInitialTask];
		}
		const target = `${project.tmuxSession}:${wName}`;

		// Create tmux window with the agent command
		const windowResult = await tmux.createWindow(
			project.tmuxSession,
			wName,
			project.cwd,
			cmd,
			env,
			unsetEnv,
		);
		if (!windowResult.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to create window: ${JSON.stringify(windowResult.error)}`,
			});
		}

		const effectiveCallback = callback ?? project.callback;
		const now = new Date().toISOString();
		const agent: Agent = {
			id,
			project: pName,
			provider: providerName,
			status: "starting",
			brief: [],
			task,
			windowName: wName,
			tmuxTarget: target,
			attachCommand: formatAttachCommand(target),
			...(providerRuntimeDir ? { providerRuntimeDir } : {}),
			...(providerSessionFile ? { providerSessionFile } : {}),
			...(subscriptionId ? { subscriptionId } : {}),
			...(effectiveCallback ? { callback: effectiveCallback } : {}),
			createdAt: now,
			lastActivity: now,
			lastCapturedOutput: "",
		};

		store.addAgent(agent);
		debugTracker?.ensureAgent(debugAgentKey(agent.project, id));

		// Emit agent_started event
		eventBus.emit({
			id: newEventId(),
			ts: now,
			project: projectNameStr,
			agentId: id,
			type: "agent_started",
			provider: providerName,
		});

		log.info("agent created", { id, provider: providerName, project: projectNameStr });

		if (initialTaskViaCli) {
			if (providerName === "claude-code") {
				setTimeout(() => {
					void dismissStartupTrustPrompt(target, id, providerName);
				}, 120);
			}
			transitionAgentStatus(projectNameStr, agent, "processing", "manager_initial_input");
			eventBus.emit({
				id: newEventId(),
				ts: new Date().toISOString(),
				project: projectNameStr,
				agentId: id,
				type: "input_sent",
				text: task,
			});
			return ok(agent);
		}

		// Send initial task after provider startup delay so the TUI is ready to accept input.
		const delayMs = initialTaskDelayMs(providerName);
		setTimeout(async () => {
			const stillExists = (): boolean => Boolean(store.getAgent(pName, id));
			if (!stillExists()) return;

			let lastStatus: AgentStatus = "starting";
			let captureFailed = false;
			let trustConfirmAttempts = 0;
			let lastTrustConfirmTs = 0;
			const waitTimeoutMs = initialTaskReadyTimeoutMs(providerName);
			const readyCheckStart = Date.now();
			if (shouldProbeStartupReadiness(providerName) && waitTimeoutMs > 0) {
				while (Date.now() - readyCheckStart < waitTimeoutMs) {
					if (!stillExists()) return;
					const captureResult = await tmux.capturePane(target, 120);
					if (!captureResult.ok) {
						if (!stillExists()) return;
						captureFailed = true;
						break;
					}
					if (
						providerName === "claude-code" &&
						looksLikeStartupTrustPrompt(captureResult.value) &&
						trustConfirmAttempts < 5
					) {
						const nowMs = Date.now();
						if (nowMs - lastTrustConfirmTs >= 250) {
							const confirmResult = await tmux.sendKeys(target, "Enter");
							if (confirmResult.ok) {
								trustConfirmAttempts++;
								lastTrustConfirmTs = nowMs;
								await Bun.sleep(120);
								continue;
							}
							if (!stillExists()) return;
							log.warn("failed to auto-confirm startup trust prompt", {
								agentId: id,
								provider: providerName,
								error: JSON.stringify(confirmResult.error),
							});
						}
					}
					lastStatus = provider.parseStatus(captureResult.value);
					if (lastStatus === "idle" || lastStatus === "waiting_input") break;
					if (lastStatus === "error" || lastStatus === "exited") break;
					await Bun.sleep(READY_POLL_INTERVAL_MS);
				}
				const waitedMs = Date.now() - readyCheckStart;
				if (lastStatus !== "idle" && lastStatus !== "waiting_input") {
					log.warn("sending initial task before provider idle prompt", {
						agentId: id,
						provider: providerName,
						delayMs,
						waitedMs,
						waitTimeoutMs,
						lastStatus,
						captureFailed,
					});
				}
			}

			if (!stillExists()) return;
			if (providerName === "claude-code") {
				await dismissStartupTrustPrompt(target, id, providerName);
			}
			if (!stillExists()) return;
			const inputResult = await sendAgentInput(
				target,
				providerName,
				formattedInitialTask,
				"initial",
			);
			if (!inputResult.ok) {
				if (!stillExists()) return;
				log.error("failed to send initial task", {
					agentId: id,
					delayMs,
					error: JSON.stringify(inputResult.error),
				});
			} else {
				transitionAgentStatus(projectNameStr, agent, "processing", "manager_initial_input");
				eventBus.emit({
					id: newEventId(),
					ts: new Date().toISOString(),
					project: projectNameStr,
					agentId: id,
					type: "input_sent",
					text: task,
				});
			}
		}, delayMs);

		return ok(agent);
	}

	function getAgent(projectNameStr: string, id: string): Result<Agent, ManagerError> {
		const pName = projectName(projectNameStr);
		const agent = store.getAgent(pName, agentId(id));
		if (!agent) {
			return err({ code: "AGENT_NOT_FOUND", id, project: projectNameStr });
		}
		return ok(agent);
	}

	function listAgents(projectNameStr: string): Result<readonly Agent[], ManagerError> {
		const pName = projectName(projectNameStr);
		if (!store.getProject(pName)) {
			return err({ code: "PROJECT_NOT_FOUND", name: projectNameStr });
		}
		return ok(store.listAgents(pName));
	}

	async function sendInput(
		projectNameStr: string,
		id: string,
		text: string,
	): Promise<Result<void, ManagerError>> {
		const agentResult = getAgent(projectNameStr, id);
		if (!agentResult.ok) return agentResult;
		const agent = agentResult.value;

		const providerResult = getProvider(agent.provider);
		if (!providerResult.ok) {
			return err({ code: "UNKNOWN_PROVIDER", name: agent.provider });
		}

		if (agent.provider === "claude-code") {
			await dismissStartupTrustPrompt(agent.tmuxTarget, agent.id, agent.provider);
		}
		const formatted = providerResult.value.formatInput(text);
		const result = await sendAgentInput(agent.tmuxTarget, agent.provider, formatted, "followup");
		if (!result.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to send input: ${JSON.stringify(result.error)}`,
			});
		}

		eventBus.emit({
			id: newEventId(),
			ts: new Date().toISOString(),
			project: projectNameStr,
			agentId: agent.id,
			type: "input_sent",
			text,
		});
		transitionAgentStatus(projectNameStr, agent, "processing", "manager_followup_input");

		return ok(undefined);
	}

	async function getAgentOutput(
		projectNameStr: string,
		id: string,
		lines?: number,
	): Promise<Result<{ output: string; lines: number }, ManagerError>> {
		const agentResult = getAgent(projectNameStr, id);
		if (!agentResult.ok) return agentResult;
		const agent = agentResult.value;

		const captureLines = lines ?? config.captureLines;
		const result = await tmux.capturePane(agent.tmuxTarget, captureLines);
		if (!result.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to capture pane: ${JSON.stringify(result.error)}`,
			});
		}

		const outputLines = result.value.split("\n");
		return ok({ output: result.value, lines: outputLines.length });
	}

	async function abortAgent(
		projectNameStr: string,
		id: string,
	): Promise<Result<void, ManagerError>> {
		const agentResult = getAgent(projectNameStr, id);
		if (!agentResult.ok) return agentResult;
		const agent = agentResult.value;

		// Send Escape then Ctrl-C — check both calls
		const escResult = await tmux.sendKeys(agent.tmuxTarget, "Escape");
		if (!escResult.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to send Escape: ${JSON.stringify(escResult.error)}`,
			});
		}

		const ctrlcResult = await tmux.sendKeys(agent.tmuxTarget, "C-c");
		if (!ctrlcResult.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to send Ctrl-C: ${JSON.stringify(ctrlcResult.error)}`,
			});
		}

		return ok(undefined);
	}

	async function deleteAgent(
		projectNameStr: string,
		id: string,
	): Promise<Result<void, ManagerError>> {
		const agentResult = getAgent(projectNameStr, id);
		if (!agentResult.ok) return agentResult;
		const agent = agentResult.value;

		// Try to gracefully exit first
		const providerResult = getProvider(agent.provider);
		if (providerResult.ok) {
			const exitCmd = providerResult.value.exitCommand();
			const exitSendResult = await tmux.sendInput(agent.tmuxTarget, exitCmd);
			if (exitSendResult.ok) {
				await Bun.sleep(1000);
			} else {
				log.warn("failed to send exit command", {
					agentId: id,
					error: JSON.stringify(exitSendResult.error),
				});
			}
		}

		// Kill the window — propagate failure
		const killResult = await tmux.killWindow(agent.tmuxTarget);
		if (!killResult.ok) {
			return err({
				code: "TMUX_ERROR",
				message: `Failed to kill window '${agent.tmuxTarget}': ${JSON.stringify(killResult.error)}`,
			});
		}

		// Emit exit event
		eventBus.emit({
			id: newEventId(),
			ts: new Date().toISOString(),
			project: projectNameStr,
			agentId: agent.id,
			type: "agent_exited",
			exitCode: null,
		});

		store.removeAgent(agent.project, agent.id);
		debugTracker?.removeAgent(debugAgentKey(agent.project, agent.id));
		log.info("agent deleted", { id, project: projectNameStr });
		return ok(undefined);
	}

	function updateAgentStatus(project: ProjectName, id: AgentId, status: AgentStatus): void {
		store.updateAgentStatus(project, id, status);
	}

	function updateAgentBrief(project: ProjectName, id: AgentId, brief: string[]): void {
		store.updateAgentBrief(project, id, brief);
	}

	function updateAgentOutput(project: ProjectName, id: AgentId, output: string): void {
		store.updateAgentOutput(project, id, output);
	}

	return {
		rehydrateProjectsFromTmux,
		rehydrateAgentsFromTmux,
		createProject,
		getProject,
		listProjects,
		updateProject,
		listSubscriptions,
		deleteProject,
		createAgent,
		getAgent,
		listAgents,
		sendInput,
		getAgentOutput,
		abortAgent,
		deleteAgent,
		updateAgentStatus,
		updateAgentBrief,
		updateAgentOutput,
	};
}

export type Manager = ReturnType<typeof createManager>;
