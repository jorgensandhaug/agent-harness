import { createApp } from "./api/app.ts";
import { loadConfig } from "./config.ts";
import { createDebugTracker } from "./debug/tracker.ts";
import { createEventBus } from "./events/bus.ts";
import { log, setLogLevel } from "./log.ts";
import { createPoller } from "./poller/poller.ts";
import { createManager } from "./session/manager.ts";
import { createStore } from "./session/store.ts";
import * as tmux from "./tmux/client.ts";
import { createWebhookClient } from "./webhook/client.ts";

export async function serveCommand(): Promise<void> {
	const startTime = Date.now();

	// 1. Load and validate config
	const config = await loadConfig();
	setLogLevel(config.logLevel);
	log.info("config loaded", { port: config.port, prefix: config.tmuxPrefix });

	// 2. Verify tmux is accessible
	const tmuxCheck = await tmux.listSessions("__startup_check__");
	if (!tmuxCheck.ok && tmuxCheck.error.code === "TMUX_NOT_INSTALLED") {
		log.error("tmux is not installed or not accessible");
		process.exit(1);
	}
	log.info("tmux available");

	// 3. Initialize in-memory store
	const store = createStore();
	log.info("store initialized");

	// 4. Initialize event bus
	const eventBus = createEventBus(config.maxEventHistory);
	log.info("event bus initialized");
	const debugTracker = createDebugTracker(config, eventBus);
	log.info("debug tracker initialized");
	const stopWebhookClient = config.webhook
		? createWebhookClient(config.webhook, eventBus, store)
		: null;

	// 5. Initialize session manager
	const manager = createManager(config, store, eventBus, debugTracker);

	// 6. Start poller
	const poller = createPoller(config, store, manager, eventBus, debugTracker);
	poller.start();

	// 7. Create and start HTTP server
	const app = createApp(manager, store, eventBus, debugTracker, startTime, config.auth?.token);

	const server = Bun.serve({
		port: config.port,
		fetch: app.fetch,
		idleTimeout: 120,
	});

	log.info("server started", { port: server.port, url: `http://localhost:${server.port}` });

	// 8. Graceful shutdown
	const shutdown = async () => {
		log.info("shutdown initiated");

		// Stop poller
		poller.stop();
		debugTracker.stop();
		stopWebhookClient?.();

		// Stop accepting new requests
		server.stop(true);

		// Send exit commands to active agents (best-effort, log failures)
		const agents = store.listAgents();
		for (const agent of agents) {
			if (agent.status !== "exited") {
				const result = await manager.deleteAgent(agent.project, agent.id);
				if (!result.ok) {
					log.warn("failed to cleanly delete agent during shutdown", {
						agentId: agent.id,
						error: JSON.stringify(result.error),
					});
				}
			}
		}

		log.info("shutdown complete — tmux sessions left intact for inspection");
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
