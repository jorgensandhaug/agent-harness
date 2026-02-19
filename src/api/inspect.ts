import type { Hono } from "hono";
import { ALLOWED_PROVIDERS } from "../providers/allowed.ts";

const PROVIDER_OPTIONS_HTML = ALLOWED_PROVIDERS.map(
	(provider) => `\t\t\t\t\t\t\t<option value="${provider}">${provider}</option>`,
).join("\n");

const INSPECT_HTML = String.raw`<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Agent Harness Inspector</title>
		<style>
			:root {
				--bg: #f4f4ef;
				--panel: #fffdf8;
				--ink: #1f1f1f;
				--muted: #5e5a52;
				--line: #d9d3c7;
				--accent: #245f4a;
				--warn: #8f3b1f;
			}

			* {
				box-sizing: border-box;
			}

			body {
				margin: 0;
				font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
				background: radial-gradient(1200px 500px at 85% -20%, #d8eadf 0%, transparent 60%), var(--bg);
				color: var(--ink);
			}

			header {
				padding: 18px 24px 10px;
				border-bottom: 1px solid var(--line);
				background: linear-gradient(120deg, #ece5d6, #f8f5ef);
			}

			h1 {
				margin: 0 0 6px;
				font-size: 20px;
				font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
			}

			.sub {
				margin: 0;
				color: var(--muted);
				font-size: 13px;
			}

			main {
				padding: 14px;
				display: grid;
				grid-template-columns: repeat(12, minmax(0, 1fr));
				gap: 12px;
			}

			.card {
				background: var(--panel);
				border: 1px solid var(--line);
				border-radius: 10px;
				padding: 12px;
				box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
			}

			.controls {
				grid-column: span 4;
			}

			.state {
				grid-column: span 8;
			}

			.events {
				grid-column: span 6;
				min-height: 320px;
			}

			.output {
				grid-column: span 6;
				min-height: 320px;
			}

			.messages {
				grid-column: span 8;
				min-height: 320px;
			}

			.last-message {
				grid-column: span 4;
				min-height: 320px;
			}

			.subscription-details {
				grid-column: span 6;
				min-height: 300px;
			}

			.webhook {
				grid-column: span 6;
				min-height: 300px;
			}

			.debug {
				grid-column: span 12;
				min-height: 220px;
			}

			@media (max-width: 1000px) {
				.controls,
				.state,
				.events,
				.output,
				.messages,
				.last-message,
				.subscription-details,
				.webhook,
				.debug {
					grid-column: span 12;
				}
			}

			label {
				display: block;
				font-size: 12px;
				color: var(--muted);
				margin-bottom: 4px;
			}

			input,
			select,
			textarea,
			button {
				width: 100%;
				font: inherit;
				padding: 8px 9px;
				border-radius: 8px;
				border: 1px solid var(--line);
				background: #fff;
				color: var(--ink);
			}

			textarea {
				resize: vertical;
				min-height: 72px;
			}

			.grid2 {
				display: grid;
				grid-template-columns: 1fr 1fr;
				gap: 8px;
			}

			.row {
				margin-bottom: 8px;
			}

			.actions {
				display: grid;
				grid-template-columns: 1fr 1fr;
				gap: 8px;
			}

			button {
				cursor: pointer;
				background: #f8f5ef;
			}

			button.primary {
				background: var(--accent);
				color: #f6fff8;
				border-color: #1d4d3c;
			}

			button.warn {
				background: #fbe8e0;
				border-color: #e6b7a6;
				color: var(--warn);
			}

			button:disabled {
				cursor: not-allowed;
				opacity: 0.6;
			}

			pre,
			code {
				font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
				font-size: 12px;
			}

			pre {
				margin: 0;
				border: 1px solid var(--line);
				border-radius: 8px;
				padding: 10px;
				background: #fbfaf7;
				max-height: 420px;
				overflow: auto;
				white-space: pre-wrap;
				word-break: break-word;
			}

			.kv {
				display: grid;
				grid-template-columns: 150px 1fr;
				row-gap: 6px;
				column-gap: 6px;
				font-size: 13px;
			}

			.kv b {
				color: var(--muted);
				font-weight: 600;
			}

			.inline {
				display: grid;
				grid-template-columns: 1fr auto;
				gap: 8px;
				align-items: center;
			}

			.mono-box {
				border: 1px solid var(--line);
				border-radius: 8px;
				padding: 8px 9px;
				background: #fbfaf7;
			}

				.status-line {
					margin-top: 10px;
					font-size: 12px;
					color: var(--muted);
				}

				.hint-line {
					margin-top: 5px;
					font-size: 12px;
					color: var(--muted);
				}
			</style>
		</head>
	<body>
		<header>
			<h1>Agent Harness Inspector</h1>
			<p class="sub">Drive agents + inspect live harness state. Use tmux side-by-side as ground truth.</p>
		</header>

		<main>
			<section class="card controls">
				<div class="row">
					<label for="project-name">Project</label>
					<input id="project-name" type="text" />
				</div>

				<div class="row">
					<label for="project-cwd">CWD</label>
					<input id="project-cwd" type="text" />
				</div>

				<div class="grid2 row">
					<div>
						<label for="provider">Provider</label>
						<select id="provider">
${PROVIDER_OPTIONS_HTML}
						</select>
					</div>
					<div>
						<label for="model">Model (optional)</label>
						<input id="model" type="text" placeholder="provider default" />
					</div>
				</div>

				<div class="row">
					<label for="subscription">Subscription (optional)</label>
					<select id="subscription"></select>
					<div id="subscription-hint" class="hint-line">loading subscriptions...</div>
				</div>

				<div class="row">
					<label for="task">Initial task</label>
					<textarea id="task">Reply with exactly: 4</textarea>
				</div>

				<div class="row actions">
					<button id="start-agent" class="primary">Start Agent</button>
					<button id="reconnect-stream">Reconnect SSE</button>
				</div>

				<div class="row">
					<label for="existing-project">Existing project</label>
					<select id="existing-project"></select>
				</div>

				<div class="row">
					<label for="existing-agent">Existing agent</label>
					<select id="existing-agent"></select>
				</div>

				<div class="row actions">
					<button id="refresh-projects">Refresh Lists</button>
					<button id="connect-existing">Connect Existing</button>
				</div>

				<div class="status-line" id="ui-status">idle</div>
			</section>

			<section class="card state">
				<div class="kv">
					<b>Project</b>
					<div id="state-project">-</div>
					<b>Agent</b>
					<div id="state-agent">-</div>
					<b>Subscription</b>
					<div id="state-subscription">-</div>
					<b>Status</b>
					<div id="state-status">-</div>
					<b>Status source</b>
					<div id="state-status-source">-</div>
					<b>Last event id</b>
					<div id="state-event-id">-</div>
					<b>Events seen</b>
					<div id="state-event-total">0</div>
					<b>Stream</b>
					<div id="state-stream">disconnected</div>
					<b>Pane dead</b>
					<div id="state-pane-dead">-</div>
					<b>Pane command</b>
					<div id="state-pane-cmd">-</div>
					<b>Mismatch badges</b>
					<div id="state-mismatch">none</div>
				</div>

				<div class="row" style="margin-top: 10px">
					<label>Attach command</label>
					<div class="inline">
						<div class="mono-box" id="attach-command">not available</div>
						<button id="copy-attach">Copy attach</button>
					</div>
				</div>

				<div class="row">
					<label for="input-text">Send input</label>
					<textarea id="input-text" placeholder="Type input to send"></textarea>
				</div>

				<div class="actions">
					<button id="send-input">Send Input</button>
					<button id="abort-agent" class="warn">Abort</button>
					<button id="delete-agent" class="warn">Delete Agent</button>
					<button id="delete-project" class="warn">Delete Project</button>
				</div>
			</section>

				<section class="card events">
					<label>Event timeline</label>
					<div class="inline" style="margin: 6px 0">
						<label>
							<input id="timeline-status-only" type="checkbox" />
							Status changes only
						</label>
						<label>
							<input id="timeline-hide-output" type="checkbox" />
							Hide output events
						</label>
					</div>
					<pre id="event-log">(none)</pre>
				</section>

			<section class="card output">
				<label>Output snapshot</label>
				<pre id="output-log">(none)</pre>
			</section>

			<section class="card messages">
				<label>Internals messages</label>
				<pre id="messages-log">(none)</pre>
			</section>

			<section class="card last-message">
				<label>Last assistant message (internals)</label>
				<pre id="last-message-log">(none)</pre>
			</section>

			<section class="card subscription-details">
				<label>Subscription details (full)</label>
				<pre id="subscription-details-log">(none)</pre>
			</section>

			<section class="card webhook">
				<label>Webhook status + tests</label>
				<div class="actions" style="margin-bottom: 8px">
					<button id="refresh-webhook">Refresh webhook</button>
					<button id="send-webhook-test" class="primary">Send webhook test</button>
					<button id="probe-webhook-receiver">Probe receiver</button>
				</div>
				<pre id="webhook-log">(none)</pre>
			</section>

			<section class="card debug">
				<label>Internal inspector state</label>
				<pre id="internal-state">{}</pre>
			</section>
		</main>

		<script>
			(() => {
				const MAX_EVENTS = 300;
				const OUTPUT_LINES = 40;
				const MESSAGE_LIMIT = 120;
				const POLL_MS = 1000;
				const EVENT_TYPES = [
					"agent_started",
					"status_changed",
					"output",
					"tool_use",
					"tool_result",
					"error",
					"agent_exited",
					"input_sent",
					"permission_requested",
					"question_asked",
					"unknown",
				];

					const state = {
						projectName: "",
						agentId: "",
						subscriptionId: "",
						projects: [],
						subscriptions: [],
						status: "idle",
						lastStatusSource: "",
						messagesSource: "",
						attachCommand: "",
							lastEventId: "",
							lastEventAt: "",
							eventCounts: {},
							eventLines: [],
							eventTotal: 0,
							timelineStatusOnly: false,
							timelineHideOutput: false,
						streamConnected: false,
					lastTransitionAt: "",
					lastPollAt: "",
					lastHeartbeatAt: "",
						lastError: "",
						windowName: "",
						lastActivity: "",
						lastOutputBytes: 0,
						messages: [],
						lastAssistantMessage: null,
						debug: null,
						webhookStatus: null,
						webhookLastTest: null,
						webhookProbe: null,
						lastWebhookRefreshAt: "",
						mismatchBadges: [],
						stream: null,
						pollTimer: null,
					};

				const el = {
					projectName: document.getElementById("project-name"),
					projectCwd: document.getElementById("project-cwd"),
					existingProject: document.getElementById("existing-project"),
					existingAgent: document.getElementById("existing-agent"),
					provider: document.getElementById("provider"),
						model: document.getElementById("model"),
						subscription: document.getElementById("subscription"),
						subscriptionHint: document.getElementById("subscription-hint"),
						task: document.getElementById("task"),
						startAgent: document.getElementById("start-agent"),
					reconnect: document.getElementById("reconnect-stream"),
					refreshProjects: document.getElementById("refresh-projects"),
					connectExisting: document.getElementById("connect-existing"),
					uiStatus: document.getElementById("ui-status"),
					stateProject: document.getElementById("state-project"),
					stateAgent: document.getElementById("state-agent"),
					stateSubscription: document.getElementById("state-subscription"),
					stateStatus: document.getElementById("state-status"),
					stateStatusSource: document.getElementById("state-status-source"),
					stateEventId: document.getElementById("state-event-id"),
						stateEventTotal: document.getElementById("state-event-total"),
						stateStream: document.getElementById("state-stream"),
						statePaneDead: document.getElementById("state-pane-dead"),
						statePaneCmd: document.getElementById("state-pane-cmd"),
						stateMismatch: document.getElementById("state-mismatch"),
						attachCommand: document.getElementById("attach-command"),
					copyAttach: document.getElementById("copy-attach"),
					inputText: document.getElementById("input-text"),
					sendInput: document.getElementById("send-input"),
					abortAgent: document.getElementById("abort-agent"),
					deleteAgent: document.getElementById("delete-agent"),
							deleteProject: document.getElementById("delete-project"),
							eventLog: document.getElementById("event-log"),
							timelineStatusOnly: document.getElementById("timeline-status-only"),
							timelineHideOutput: document.getElementById("timeline-hide-output"),
							outputLog: document.getElementById("output-log"),
						messagesLog: document.getElementById("messages-log"),
						lastMessageLog: document.getElementById("last-message-log"),
						subscriptionDetailsLog: document.getElementById("subscription-details-log"),
						refreshWebhook: document.getElementById("refresh-webhook"),
						sendWebhookTest: document.getElementById("send-webhook-test"),
						probeWebhookReceiver: document.getElementById("probe-webhook-receiver"),
						webhookLog: document.getElementById("webhook-log"),
						internalState: document.getElementById("internal-state"),
					};

				function stamp() {
					return new Date().toISOString().slice(11, 19);
				}

				function setUiStatus(text) {
					el.uiStatus.textContent = text;
				}

					function renderEventLog() {
						const filtered = state.eventLines.filter((entry) => {
							if (state.timelineStatusOnly) {
								return entry.type === "status_changed" || entry.type === "meta";
							}
							if (state.timelineHideOutput && entry.type === "output") {
								return false;
							}
							return true;
						});
						el.eventLog.textContent = filtered.length > 0 ? filtered.map((entry) => entry.line).join("\n") : "(none)";
					}

					function pushEvent(line, type = "meta") {
						state.eventLines.push({ line, type });
						if (state.eventLines.length > MAX_EVENTS) {
							state.eventLines.splice(0, state.eventLines.length - MAX_EVENTS);
						}
						renderEventLog();
					}

					function summarizePayload(eventType, payload) {
						if (!payload || typeof payload !== "object") return "";
						if (eventType === "status_changed") {
						const from = payload.from || "?";
						const to = payload.to || "?";
						const source =
							typeof payload.source === "string" && payload.source.length > 0
								? payload.source
								: "unknown";
						return from + " -> " + to + " (via " + source + ")";
					}
					if (typeof payload.text === "string") return payload.text.slice(0, 120);
					if (typeof payload.message === "string") return payload.message.slice(0, 120);
					if (typeof payload.description === "string") return payload.description.slice(0, 120);
					if (typeof payload.question === "string") return payload.question.slice(0, 120);
						return JSON.stringify(payload).slice(0, 120);
					}

					function summarizeText(text, maxLen) {
						const normalized = String(text || "").replace(/\s+/g, " ").trim();
						if (!normalized) return "(empty)";
						if (normalized.length <= maxLen) return normalized;
						return normalized.slice(0, maxLen - 1) + "…";
					}

					function formatMessageLine(message) {
						const ts = typeof message.ts === "string" ? message.ts : "";
						const role = typeof message.role === "string" ? message.role : "unknown";
						const text = summarizeText(message.text, 220);
						return (ts ? "[" + ts + "] " : "") + role + ": " + text;
					}

					function renderMessages() {
						const list = Array.isArray(state.messages) ? state.messages : [];
						if (list.length === 0) {
							el.messagesLog.textContent = "(none)";
						} else {
							el.messagesLog.textContent = list.map((message) => formatMessageLine(message)).join("\n");
						}

						if (state.lastAssistantMessage && typeof state.lastAssistantMessage === "object") {
							const message = state.lastAssistantMessage;
							const ts = typeof message.ts === "string" ? message.ts : "-";
							const finish =
								typeof message.finishReason === "string" && message.finishReason.length > 0
									? message.finishReason
									: "-";
							const text = String(message.text || "").trim() || "(empty)";
							el.lastMessageLog.textContent = [
								"source: " + (state.messagesSource || "unknown"),
								"ts: " + ts,
								"finish: " + finish,
								"",
								text,
							].join("\n");
						} else {
							el.lastMessageLog.textContent =
								"source: " + (state.messagesSource || "unknown") + "\n\n(none)";
						}
					}

					function computeMismatches() {
						const badges = [];
						const debug = state.debug;
						const paneDead = debug && debug.tmux ? debug.tmux.paneDead : null;
						const paneCmd = debug && debug.tmux ? debug.tmux.paneCurrentCommand : null;
						const shellCommands = ["bash", "zsh", "sh", "fish"];

						if (paneDead === true && state.status !== "exited") {
							badges.push("pane_dead_not_exited");
						}

						if (
							state.status === "processing" &&
							typeof paneCmd === "string" &&
							shellCommands.includes(paneCmd)
						) {
							badges.push("processing_but_shell_active");
						}

						if (state.streamConnected && state.status !== "exited" && state.lastEventAt) {
							const lastEventAgeMs = Date.now() - Date.parse(state.lastEventAt);
							if (Number.isFinite(lastEventAgeMs) && lastEventAgeMs > 15000) {
								badges.push("stream_stalled_15s");
							}

							const diffBytes = debug && debug.poll ? debug.poll.lastDiffBytes : 0;
							if (
								Number.isFinite(lastEventAgeMs) &&
								lastEventAgeMs > 10000 &&
								typeof diffBytes === "number" &&
								diffBytes > 0
							) {
								badges.push("diff_without_recent_events");
							}
						}

						return badges;
					}

					function renderState() {
						state.mismatchBadges = computeMismatches();
						el.stateProject.textContent = state.projectName || "-";
						el.stateAgent.textContent = state.agentId || "-";
						el.stateSubscription.textContent = state.subscriptionId || "-";
						el.stateStatus.textContent = state.status || "-";
						el.stateStatusSource.textContent = state.lastStatusSource || "-";
						el.stateEventId.textContent = state.lastEventId || "-";
						el.stateEventTotal.textContent = String(state.eventTotal);
						el.stateStream.textContent = state.streamConnected ? "connected" : "disconnected";
						el.statePaneDead.textContent =
							state.debug && state.debug.tmux
								? state.debug.tmux.paneDead === null
									? "null"
									: String(state.debug.tmux.paneDead)
								: "-";
						el.statePaneCmd.textContent =
							state.debug && state.debug.tmux && state.debug.tmux.paneCurrentCommand
								? state.debug.tmux.paneCurrentCommand
								: "-";
						el.stateMismatch.textContent =
							state.mismatchBadges.length > 0 ? state.mismatchBadges.join(", ") : "none";
						el.attachCommand.textContent = state.attachCommand || "not available";

						const debugState = {
							projectName: state.projectName || null,
							agentId: state.agentId || null,
							subscriptionId: state.subscriptionId || null,
							subscriptionCount: Array.isArray(state.subscriptions) ? state.subscriptions.length : 0,
							status: state.status || null,
							lastStatusSource: state.lastStatusSource || null,
							messagesSource: state.messagesSource || null,
							attachCommand: state.attachCommand || null,
							streamConnected: state.streamConnected,
							lastEventId: state.lastEventId || null,
							lastEventAt: state.lastEventAt || null,
							lastTransitionAt: state.lastTransitionAt || null,
							lastPollAt: state.lastPollAt || null,
							lastHeartbeatAt: state.lastHeartbeatAt || null,
							windowName: state.windowName || null,
							lastActivity: state.lastActivity || null,
							lastOutputBytes: state.lastOutputBytes,
							messageCount: Array.isArray(state.messages) ? state.messages.length : 0,
							lastAssistantMessage: state.lastAssistantMessage,
							eventCounts: state.eventCounts,
							mismatchBadges: state.mismatchBadges,
							lastError: state.lastError || null,
							webhookStatus: state.webhookStatus,
							webhookLastTest: state.webhookLastTest,
							webhookProbe: state.webhookProbe,
							debugEndpoint: state.debug,
						};

							renderSubscriptionDetails();
							renderWebhookPanel();
							renderEventLog();
							renderMessages();
							el.internalState.textContent = JSON.stringify(debugState, null, 2);
						}

				async function api(path, init) {
					return fetch(path, {
						headers: { "content-type": "application/json" },
						...init,
					});
				}

				function setSelectOptions(selectEl, options, emptyLabel) {
					selectEl.innerHTML = "";
					if (!options.length) {
						const opt = document.createElement("option");
						opt.value = "";
						opt.textContent = emptyLabel;
						selectEl.appendChild(opt);
						return;
					}

					for (const option of options) {
						const opt = document.createElement("option");
						opt.value = option.value;
						opt.textContent = option.label;
						selectEl.appendChild(opt);
					}
				}

					function subscriptionLabel(subscription) {
						const id = String(subscription.id || "");
						const mode = typeof subscription.mode === "string" ? subscription.mode : "unknown";
						const provider =
							typeof subscription.provider === "string" ? subscription.provider : "unknown";
						const source =
							typeof subscription.source === "string" ? subscription.source : "configured";
						const valid = subscription.valid === false ? "invalid" : "ok";
						const locatorPath =
							subscription.locator &&
							typeof subscription.locator === "object" &&
							typeof subscription.locator.path === "string"
								? subscription.locator.path
								: typeof subscription.sourceDir === "string"
									? subscription.sourceDir
									: null;
						const locatorShort = locatorPath
							? locatorPath.length > 36
								? "…/" + locatorPath.slice(-35)
								: locatorPath
							: "unknown-path";
						const reason =
							subscription.valid === false &&
							typeof subscription.reason === "string" &&
							subscription.reason.length > 0
								? ", " + subscription.reason
								: "";
						return (
							id +
							" (" +
							provider +
							"/" +
							mode +
							", " +
							source +
							", " +
							valid +
							", " +
							locatorShort +
							reason +
							")"
						);
					}

					function normalizeProviderId(provider) {
						if (provider === "claude") {
							return "claude-code";
						}
						return provider;
					}

					function summarizeSubscriptionsByProvider(subscriptions) {
						const counts = {};
						for (const subscription of subscriptions) {
							if (!subscription || typeof subscription !== "object") {
								continue;
							}
							const rawProvider =
								typeof subscription.provider === "string" && subscription.provider.length > 0
									? subscription.provider
									: "unknown";
							const provider = normalizeProviderId(rawProvider);
							counts[provider] = (counts[provider] || 0) + 1;
						}

						return Object.entries(counts)
							.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
							.map(([provider, count]) => String(provider) + "=" + String(count))
							.join(", ");
					}

					function setSubscriptionHint(text) {
						el.subscriptionHint.textContent = text;
					}

					function renderSubscriptionDetails() {
						const selectedId = String(el.subscription.value || "").trim();
						const list = Array.isArray(state.subscriptions) ? state.subscriptions : [];
						if (list.length === 0) {
							el.subscriptionDetailsLog.textContent = "(no subscriptions loaded)";
							return;
						}
						if (!selectedId) {
							el.subscriptionDetailsLog.textContent = JSON.stringify(
								{
									note: "no subscription selected; using provider default",
									provider: String(el.provider.value || ""),
									availableCount: list.length,
									availableIds: list.map((subscription) => String(subscription.id || "")),
								},
								null,
								2,
							);
							return;
						}

						const selected = list.find(
							(subscription) => String(subscription.id || "") === selectedId,
						);
						if (!selected) {
							el.subscriptionDetailsLog.textContent = "(selected subscription not found in latest list)";
							return;
						}
						el.subscriptionDetailsLog.textContent = JSON.stringify(selected, null, 2);
					}

					function renderWebhookPanel() {
						const payload = {
							webhookStatus: state.webhookStatus,
							lastTest: state.webhookLastTest,
							lastProbe: state.webhookProbe,
							lastWebhookRefreshAt: state.lastWebhookRefreshAt || null,
						};
						el.webhookLog.textContent = JSON.stringify(payload, null, 2);
					}

					async function refreshSubscriptionsList() {
						const provider = normalizeProviderId(String(el.provider.value || "").trim());
						const response = await api("/api/v1/subscriptions");
						if (!response.ok) {
							setSelectOptions(el.subscription, [], "(failed to load subscriptions)");
							setSubscriptionHint("failed to load subscriptions (HTTP " + response.status + ")");
							state.lastError = "load subscriptions failed: " + response.status;
							state.subscriptions = [];
							renderSubscriptionDetails();
							renderState();
							return;
						}
						const json = await response.json();
						const subscriptions = Array.isArray(json.subscriptions) ? json.subscriptions : [];
						state.subscriptions = subscriptions;
						const providerSubscriptions = subscriptions.filter((subscription) => {
							if (!subscription || typeof subscription !== "object") {
								return false;
							}
							const subscriptionProvider = normalizeProviderId(
								typeof subscription.provider === "string" ? subscription.provider : "",
							);
							return subscriptionProvider === provider;
						});
						const options = providerSubscriptions
							.map((subscription) => ({
								value: String(subscription.id || ""),
								label: subscriptionLabel(subscription),
							}));

						const withDefault = [{ value: "", label: "(none / provider default)" }, ...options];
						const selected = String(el.subscription.value || "").trim();
						setSelectOptions(el.subscription, withDefault, "(none / provider default)");
						if (selected && withDefault.some((option) => option.value === selected)) {
							el.subscription.value = selected;
						}

						if (subscriptions.length === 0) {
							setSubscriptionHint("no subscriptions configured");
							renderSubscriptionDetails();
							return;
						}

						if (providerSubscriptions.length === 0) {
							setSubscriptionHint(
								"none for provider '" +
									provider +
									"' (available: " +
									summarizeSubscriptionsByProvider(subscriptions) +
									")",
							);
							renderSubscriptionDetails();
							return;
						}

						const invalidCount = providerSubscriptions.filter(
							(subscription) => subscription.valid === false,
						).length;
						setSubscriptionHint(
							"provider '" +
								provider +
								"': " +
								String(providerSubscriptions.length) +
								" found (" +
								String(invalidCount) +
								" invalid)",
						);
						renderSubscriptionDetails();
					}

					async function refreshWebhookStatus() {
						try {
							const response = await api("/api/v1/webhook/status");
							if (!response.ok) {
								state.lastError = "webhook status failed: " + response.status;
								return;
							}
							const json = await response.json();
							state.webhookStatus = json;
							state.lastWebhookRefreshAt = new Date().toISOString();
						} catch (error) {
							state.lastError =
								error instanceof Error ? error.message : "webhook status request failed";
						}
						renderWebhookPanel();
						renderState();
					}

					async function sendWebhookTest() {
						try {
							const payload = {
								project: state.projectName || "__inspect__",
								agentId: state.agentId || "__inspect__",
								provider: String(el.provider.value || "") || "inspect",
								status: state.status || "idle",
								lastMessage:
									state.lastAssistantMessage &&
									typeof state.lastAssistantMessage === "object" &&
									typeof state.lastAssistantMessage.text === "string"
										? state.lastAssistantMessage.text
										: "manual inspector webhook test",
							};
							const response = await api("/api/v1/webhook/test", {
								method: "POST",
								body: JSON.stringify(payload),
							});
							const json = await response.json().catch(() => ({}));
							state.webhookLastTest = {
								httpStatus: response.status,
								payload,
								response: json,
							};
							if (!response.ok) {
								state.lastError = "webhook test failed: " + response.status;
							} else {
								pushEvent("[" + stamp() + "] webhook test sent");
							}
						} catch (error) {
							state.lastError =
								error instanceof Error ? error.message : "webhook test request failed";
						}
						await refreshWebhookStatus();
						renderWebhookPanel();
						renderState();
					}

					async function probeWebhookReceiver() {
						try {
							const response = await api("/api/v1/webhook/probe-receiver", {
								method: "POST",
								body: JSON.stringify({}),
							});
							const json = await response.json().catch(() => ({}));
							state.webhookProbe = {
								httpStatus: response.status,
								response: json,
							};
							if (!response.ok) {
								state.lastError = "webhook probe failed: " + response.status;
							} else {
								pushEvent("[" + stamp() + "] webhook receiver probe completed");
							}
						} catch (error) {
							state.lastError =
								error instanceof Error ? error.message : "webhook probe request failed";
						}
						renderWebhookPanel();
						renderState();
					}

				async function refreshAgentsList() {
					const project = String(el.existingProject.value || "").trim();
					if (!project) {
						setSelectOptions(el.existingAgent, [], "(no agents)");
						return;
					}

					const response = await api("/api/v1/projects/" + encodeURIComponent(project));
					if (!response.ok) {
						setSelectOptions(el.existingAgent, [], "(failed to load agents)");
						state.lastError = "load agents failed: " + response.status;
						renderState();
						return;
					}

					const json = await response.json();
					const agents = Array.isArray(json.agents) ? json.agents : [];
					const options = agents.map((agent) => ({
						value: String(agent.id || ""),
						label: (() => {
							const id = String(agent.id || "");
							const provider = String(agent.provider || "unknown");
							const status = String(agent.status || "unknown");
							const subscription =
								typeof agent.subscriptionId === "string" && agent.subscriptionId.length > 0
									? ", sub=" + agent.subscriptionId
									: "";
							return id + " (" + provider + "/" + status + subscription + ")";
						})(),
					}));
					setSelectOptions(el.existingAgent, options, "(no agents)");

					if (state.agentId && options.some((option) => option.value === state.agentId)) {
						el.existingAgent.value = state.agentId;
					}
				}

				function selectedProjectRecord() {
					const name = String(el.existingProject.value || "").trim();
					if (!name) return null;
					const projects = Array.isArray(state.projects) ? state.projects : [];
					return (
						projects.find(
							(project) => project && typeof project.name === "string" && project.name === name,
						) || null
					);
				}

				function syncProjectInputsFromSelection() {
					const selected = selectedProjectRecord();
					if (!selected) return;
					el.projectName.value = String(selected.name || "");
					if (typeof selected.cwd === "string" && selected.cwd.length > 0) {
						el.projectCwd.value = selected.cwd;
					}
				}

				async function refreshProjectsList() {
					const response = await api("/api/v1/projects");
					if (!response.ok) {
						setSelectOptions(el.existingProject, [], "(failed to load projects)");
						setSelectOptions(el.existingAgent, [], "(no agents)");
						state.lastError = "load projects failed: " + response.status;
						renderState();
						return;
					}

					const json = await response.json();
					const projects = Array.isArray(json.projects) ? json.projects : [];
					state.projects = projects;
					const preferredProject =
						state.projectName ||
						String(el.projectName.value || "").trim() ||
						String(el.existingProject.value || "").trim();
					const options = projects.map((project) => ({
						value: String(project.name || ""),
						label:
							String(project.name || "") +
							" (" +
							String(Number.isFinite(project.agentCount) ? project.agentCount : 0) +
							" agents)",
					}));
					setSelectOptions(el.existingProject, options, "(no projects)");

					if (preferredProject && options.some((option) => option.value === preferredProject)) {
						el.existingProject.value = preferredProject;
					} else if (options.length > 0) {
						el.existingProject.value = options[0].value;
					}
					syncProjectInputsFromSelection();
					await refreshAgentsList();
				}

				function encodedProject() {
					return encodeURIComponent(state.projectName);
				}

				function encodedAgent() {
					return encodeURIComponent(state.agentId);
				}

				async function ensureProject(name, cwd) {
					const response = await api("/api/v1/projects", {
						method: "POST",
						body: JSON.stringify({ name, cwd }),
					});
					if (response.status === 201) {
						pushEvent("[" + stamp() + "] project created: " + name);
						return;
					}
					if (response.status === 409) {
						pushEvent("[" + stamp() + "] project exists: " + name);
						return;
					}
					throw new Error("project create failed: " + response.status + " " + (await response.text()));
				}

				function closeStream() {
					if (state.stream) {
						state.stream.close();
						state.stream = null;
					}
					state.streamConnected = false;
				}

				function stopPolling() {
					if (state.pollTimer) {
						clearInterval(state.pollTimer);
						state.pollTimer = null;
					}
				}

				async function copyAttach() {
					if (!state.attachCommand) {
						setUiStatus("no attach command to copy");
						return;
					}

					try {
						if (navigator.clipboard && navigator.clipboard.writeText) {
							await navigator.clipboard.writeText(state.attachCommand);
						} else {
							const area = document.createElement("textarea");
							area.value = state.attachCommand;
							area.style.position = "fixed";
							area.style.left = "-1000px";
							document.body.appendChild(area);
							area.select();
							document.execCommand("copy");
							area.remove();
						}
						setUiStatus("attach command copied");
					} catch (error) {
						state.lastError = error instanceof Error ? error.message : String(error);
						setUiStatus("clipboard write failed");
					}
					renderState();
				}

					function handleEvent(eventType, event) {
						state.lastEventId = event.lastEventId || state.lastEventId;
						state.lastEventAt = new Date().toISOString();
						state.eventCounts[eventType] = (state.eventCounts[eventType] || 0) + 1;
						state.eventTotal += 1;

					let payload;
					try {
						payload = event.data ? JSON.parse(event.data) : {};
					} catch {
						payload = { raw: event.data || "" };
					}

					if (eventType === "status_changed" && payload && typeof payload.to === "string") {
						state.status = payload.to;
						state.lastStatusSource =
							typeof payload.source === "string" ? payload.source : "unknown";
						state.lastTransitionAt = new Date().toISOString();
					}

						const summary = summarizePayload(eventType, payload);
						pushEvent("[" + stamp() + "] " + eventType + (summary ? " " + summary : ""), eventType);
						renderState();
					}

				function connectStream(since) {
					if (!state.projectName || !state.agentId) return;
					closeStream();

					const url = new URL(
						"/api/v1/projects/" + encodedProject() + "/agents/" + encodedAgent() + "/events",
						window.location.origin,
					);
					if (since) {
						url.searchParams.set("since", since);
					}

					const stream = new EventSource(url.toString());
					state.stream = stream;
					setUiStatus("connecting SSE...");

					stream.onopen = () => {
						state.streamConnected = true;
						setUiStatus("SSE connected");
						pushEvent("[" + stamp() + "] stream connected");
						renderState();
					};

					stream.onerror = () => {
						state.streamConnected = false;
						state.lastError = "stream disconnected";
						setUiStatus("SSE disconnected");
						renderState();
					};

					stream.addEventListener("heartbeat", () => {
						state.lastHeartbeatAt = new Date().toISOString();
						renderState();
					});

					for (const eventType of EVENT_TYPES) {
						stream.addEventListener(eventType, (event) => handleEvent(eventType, event));
					}
				}

					async function pollSnapshot() {
						if (!state.projectName || !state.agentId) return;
						try {
							const pollErrors = [];
							const agentRes = await api(
								"/api/v1/projects/" + encodedProject() + "/agents/" + encodedAgent(),
							);
							if (!agentRes.ok) {
								throw new Error("agent poll failed: " + agentRes.status + " " + (await agentRes.text()));
						}
						const agentJson = await agentRes.json();
						state.status = agentJson.status || state.status;
						if (agentJson.agent) {
							state.attachCommand = agentJson.agent.attachCommand || state.attachCommand;
							state.windowName = agentJson.agent.windowName || "";
							state.lastActivity = agentJson.agent.lastActivity || "";
							state.subscriptionId =
								typeof agentJson.agent.subscriptionId === "string"
									? agentJson.agent.subscriptionId
									: state.subscriptionId;
						}

						const outputRes = await api(
							"/api/v1/projects/" +
								encodedProject() +
								"/agents/" +
								encodedAgent() +
									"/output?lines=" +
									String(OUTPUT_LINES),
							);
							if (!outputRes.ok) {
								throw new Error("output poll failed: " + outputRes.status + " " + (await outputRes.text()));
							}
							const outputJson = await outputRes.json();
							const outputText = typeof outputJson.output === "string" ? outputJson.output : "";
							state.lastOutputBytes = outputText.length;
							el.outputLog.textContent = outputText || "(empty)";

							const messagesRes = await api(
								"/api/v1/projects/" +
									encodedProject() +
									"/agents/" +
									encodedAgent() +
									"/messages?limit=" +
									String(MESSAGE_LIMIT) +
									"&role=all",
							);
							if (messagesRes.ok) {
								const messagesJson = await messagesRes.json();
								state.messages = Array.isArray(messagesJson.messages) ? messagesJson.messages : [];
								if (typeof messagesJson.source === "string") {
									state.messagesSource = messagesJson.source;
								}
								if ("lastAssistantMessage" in messagesJson) {
									state.lastAssistantMessage = messagesJson.lastAssistantMessage || null;
								}
							} else {
								pollErrors.push("messages poll failed: " + messagesRes.status);
							}

							const lastMessageRes = await api(
								"/api/v1/projects/" +
									encodedProject() +
									"/agents/" +
									encodedAgent() +
									"/messages/last",
							);
							if (lastMessageRes.ok) {
								const lastMessageJson = await lastMessageRes.json();
								state.lastAssistantMessage = lastMessageJson.lastAssistantMessage || null;
								if (typeof lastMessageJson.source === "string") {
									state.messagesSource = lastMessageJson.source;
								}
							} else {
								pollErrors.push("messages/last poll failed: " + lastMessageRes.status);
							}

							const debugRes = await api(
								"/api/v1/projects/" + encodedProject() + "/agents/" + encodedAgent() + "/debug",
							);
							if (debugRes.ok) {
								const debugJson = await debugRes.json();
								state.debug = debugJson.debug || null;
							} else {
								pollErrors.push("debug poll failed: " + debugRes.status);
							}

							state.lastPollAt = new Date().toISOString();
							state.lastError = pollErrors.join("; ");
							const nowMs = Date.now();
							const lastWebhookMs = state.lastWebhookRefreshAt
								? Date.parse(state.lastWebhookRefreshAt)
								: Number.NaN;
							if (!Number.isFinite(lastWebhookMs) || nowMs - lastWebhookMs >= 5000) {
								void refreshWebhookStatus();
							}
						} catch (error) {
							state.lastError = error instanceof Error ? error.message : String(error);
						}
						renderState();
					}

				function startPolling() {
					stopPolling();
					void pollSnapshot();
					state.pollTimer = setInterval(() => {
						void pollSnapshot();
					}, POLL_MS);
				}

				async function connectExisting() {
					const projectName = String(el.existingProject.value || "").trim();
					const agentId = String(el.existingAgent.value || "").trim();
					if (!projectName || !agentId) {
						setUiStatus("select existing project+agent first");
						return;
					}

					setUiStatus("connecting existing...");
					closeStream();
					stopPolling();

					try {
						const response = await api(
							"/api/v1/projects/" + encodeURIComponent(projectName) + "/agents/" + encodeURIComponent(agentId),
						);
						if (!response.ok) {
							throw new Error(
								"agent load failed: " + response.status + " " + (await response.text()),
							);
						}

						const json = await response.json();
						state.projectName = projectName;
						state.agentId = agentId;
						state.subscriptionId =
							json.agent && typeof json.agent.subscriptionId === "string"
								? json.agent.subscriptionId
								: "";
						state.status = json.status || "idle";
						state.lastStatusSource = "";
						state.attachCommand = json.agent && json.agent.attachCommand ? json.agent.attachCommand : "";
						state.windowName = json.agent && json.agent.windowName ? json.agent.windowName : "";
						state.lastActivity = json.agent && json.agent.lastActivity ? json.agent.lastActivity : "";
						if (json.agent && typeof json.agent.provider === "string") {
							el.provider.value = json.agent.provider;
						}
						state.eventCounts = {};
						state.eventLines = [];
						state.eventTotal = 0;
						state.lastEventId = "";
						state.lastEventAt = "";
						state.lastError = "";
						state.messagesSource = "";
						state.messages = [];
						state.lastAssistantMessage = null;
						state.debug = null;
						state.mismatchBadges = [];

						pushEvent("[" + stamp() + "] connected existing agent: " + agentId);
						await refreshSubscriptionsList();
						if (
							state.subscriptionId &&
							Array.from(el.subscription.options).some(
								(option) => option.value === state.subscriptionId,
							)
						) {
							el.subscription.value = state.subscriptionId;
						}
						renderState();
						await copyAttach();
						connectStream();
						startPolling();
						setUiStatus("connected existing");
					} catch (error) {
						state.lastError = error instanceof Error ? error.message : String(error);
						setUiStatus("connect existing failed");
						renderState();
					}
				}

				async function startAgent() {
					const projectName = String(el.projectName.value || "").trim();
					const cwd = String(el.projectCwd.value || "").trim();
					const provider = String(el.provider.value || "").trim();
					const task = String(el.task.value || "").trim();
					const model = String(el.model.value || "").trim();
					const subscription = String(el.subscription.value || "").trim();

					if (!projectName || !cwd || !provider || !task) {
						setUiStatus("project/cwd/provider/task required");
						return;
					}

					setUiStatus("starting agent...");
					try {
						await ensureProject(projectName, cwd);
						const createAgentRes = await api(
							"/api/v1/projects/" + encodeURIComponent(projectName) + "/agents",
							{
								method: "POST",
								body: JSON.stringify({
									provider,
									task,
									model: model || undefined,
									subscription: subscription || undefined,
								}),
							},
						);
						if (!createAgentRes.ok) {
							throw new Error(
								"agent create failed: " + createAgentRes.status + " " + (await createAgentRes.text()),
							);
						}
						const createAgentJson = await createAgentRes.json();
						state.projectName = projectName;
						state.agentId = createAgentJson.agent.id || "";
						state.subscriptionId =
							(typeof createAgentJson.agent.subscriptionId === "string" &&
							createAgentJson.agent.subscriptionId.length > 0
								? createAgentJson.agent.subscriptionId
								: subscription) || "";
						state.status = createAgentJson.agent.status || "starting";
						state.lastStatusSource = "";
						state.attachCommand = createAgentJson.agent.attachCommand || "";
						state.eventCounts = {};
						state.eventLines = [];
							state.eventTotal = 0;
							state.lastEventId = "";
							state.lastEventAt = "";
							state.lastError = "";
							state.messagesSource = "";
							state.messages = [];
							state.lastAssistantMessage = null;
							state.debug = null;
							state.mismatchBadges = [];

						pushEvent("[" + stamp() + "] agent created: " + state.agentId);
						renderState();
						await copyAttach();
						connectStream();
						startPolling();
						await refreshProjectsList();
					} catch (error) {
						state.lastError = error instanceof Error ? error.message : String(error);
						setUiStatus("start failed");
						renderState();
					}
				}

				async function sendInput() {
					if (!state.projectName || !state.agentId) {
						setUiStatus("start an agent first");
						return;
					}
					const text = String(el.inputText.value || "");
					if (!text.trim()) {
						setUiStatus("input is empty");
						return;
					}
					const response = await api(
						"/api/v1/projects/" + encodedProject() + "/agents/" + encodedAgent() + "/input",
						{
							method: "POST",
							body: JSON.stringify({ text }),
						},
					);
					if (!response.ok) {
						setUiStatus("input failed: " + response.status);
						return;
					}
					pushEvent("[" + stamp() + "] input sent");
					el.inputText.value = "";
				}

				async function abortAgent() {
					if (!state.projectName || !state.agentId) return;
					const response = await api(
						"/api/v1/projects/" + encodedProject() + "/agents/" + encodedAgent() + "/abort",
						{ method: "POST" },
					);
					if (response.ok) {
						pushEvent("[" + stamp() + "] abort requested");
					} else {
						state.lastError = "abort failed: " + response.status;
					}
					renderState();
				}

				async function deleteAgent() {
					if (!state.projectName || !state.agentId) return;
					const response = await api(
						"/api/v1/projects/" + encodedProject() + "/agents/" + encodedAgent(),
						{ method: "DELETE" },
					);
					if (response.status === 204) {
						pushEvent("[" + stamp() + "] agent deleted");
						closeStream();
						stopPolling();
						state.agentId = "";
						state.subscriptionId = "";
						state.status = "idle";
						state.lastStatusSource = "";
						state.attachCommand = "";
						state.messagesSource = "";
						state.messages = [];
						state.lastAssistantMessage = null;
						state.debug = null;
						state.mismatchBadges = [];
						void refreshProjectsList();
					} else {
						state.lastError = "delete agent failed: " + response.status;
					}
					renderState();
				}

				async function deleteProject() {
					if (!state.projectName) return;
					const response = await api("/api/v1/projects/" + encodedProject(), { method: "DELETE" });
					if (response.status === 204) {
						pushEvent("[" + stamp() + "] project deleted");
						closeStream();
						stopPolling();
						state.projectName = "";
						state.agentId = "";
						state.subscriptionId = "";
						state.status = "idle";
						state.lastStatusSource = "";
						state.attachCommand = "";
						state.messagesSource = "";
						state.messages = [];
						state.lastAssistantMessage = null;
						state.debug = null;
						state.mismatchBadges = [];
						void refreshProjectsList();
					} else {
						state.lastError = "delete project failed: " + response.status;
					}
					renderState();
				}

				el.startAgent.addEventListener("click", () => {
					void startAgent();
				});
				el.reconnect.addEventListener("click", () => {
					connectStream(state.lastEventId || undefined);
				});
				el.refreshProjects.addEventListener("click", () => {
					void refreshProjectsList();
				});
				el.provider.addEventListener("change", () => {
					void refreshSubscriptionsList();
				});
					el.subscription.addEventListener("change", () => {
						renderSubscriptionDetails();
					});
					el.timelineStatusOnly.addEventListener("change", () => {
						state.timelineStatusOnly = Boolean(el.timelineStatusOnly.checked);
						renderEventLog();
					});
					el.timelineHideOutput.addEventListener("change", () => {
						state.timelineHideOutput = Boolean(el.timelineHideOutput.checked);
						renderEventLog();
					});
					el.existingProject.addEventListener("change", () => {
						syncProjectInputsFromSelection();
						void refreshAgentsList();
					});
				el.connectExisting.addEventListener("click", () => {
					void connectExisting();
				});
				el.copyAttach.addEventListener("click", () => {
					void copyAttach();
				});
				el.sendInput.addEventListener("click", () => {
					void sendInput();
				});
				el.abortAgent.addEventListener("click", () => {
					void abortAgent();
				});
				el.deleteAgent.addEventListener("click", () => {
					void deleteAgent();
				});
				el.deleteProject.addEventListener("click", () => {
					void deleteProject();
				});
				el.refreshWebhook.addEventListener("click", () => {
					void refreshWebhookStatus();
				});
				el.sendWebhookTest.addEventListener("click", () => {
					void sendWebhookTest();
				});
				el.probeWebhookReceiver.addEventListener("click", () => {
					void probeWebhookReceiver();
				});

					el.projectName.value = "";
					el.projectCwd.value = ".";
					el.timelineStatusOnly.checked = false;
					el.timelineHideOutput.checked = false;
					void refreshSubscriptionsList();
				void refreshWebhookStatus();
				void refreshProjectsList();
				renderSubscriptionDetails();
				renderWebhookPanel();
				renderState();
			})();
		</script>
	</body>
</html>
`;

export function registerInspectRoutes(app: Hono): void {
	app.get("/inspect", (c) => c.html(INSPECT_HTML));
}
