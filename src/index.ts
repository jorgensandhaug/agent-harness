import { log } from "./log.ts";
import { serveCommand } from "./serve.ts";

serveCommand().catch((e) => {
	log.error("fatal startup error", {
		error: e instanceof Error ? e.message : String(e),
		stack: e instanceof Error ? e.stack : undefined,
	});
	process.exit(1);
});
