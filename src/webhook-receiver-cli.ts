import { loadConfig, startWebhookReceiver } from "./webhook-receiver.ts";

const config = loadConfig();
const server = startWebhookReceiver(config);

const shutdown = () => {
	server.stop(true);
	process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
