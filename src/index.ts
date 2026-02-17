import { createApp } from "./api/app.ts";
import { loadConfig } from "./config.ts";
import { createEventBus } from "./events/bus.ts";
import { log, setLogLevel } from "./log.ts";
import { createPoller } from "./poller/poller.ts";
import { createManager } from "./session/manager.ts";
import { createStore } from "./session/store.ts";
import * as tmux from "./tmux/client.ts";

async function main(): Promise<void> {
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

	// 5. Initialize session manager
	const manager = createManager(config, store, eventBus);

	// 6. Start poller
	const poller = createPoller(config, store, manager, eventBus);
	poller.start();

	// 7. Create and start HTTP server
	const app = createApp(manager, store, eventBus, startTime);

	const server = Bun.serve({
		port: config.port,
		fetch: app.fetch,
	});

	log.info("server started", { port: server.port, url: `http://localhost:${server.port}` });

	// 8. Graceful shutdown
	const shutdown = async () => {
		log.info("shutdown initiated");

		// Stop poller
		poller.stop();

		// Stop accepting new requests
		server.stop(true);

		// Send exit commands to active agents
		const agents = store.listAgents();
		for (const agent of agents) {
			if (agent.status !== "exited") {
				try {
					await manager.deleteAgent(agent.project, agent.id);
				} catch {
					// Best-effort shutdown
				}
			}
		}

		log.info("shutdown complete — tmux sessions left intact for inspection");
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((e) => {
	log.error("fatal startup error", {
		error: e instanceof Error ? e.message : String(e),
		stack: e instanceof Error ? e.stack : undefined,
	});
	process.exit(1);
});
