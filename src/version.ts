type PackageLike = {
	version?: unknown;
};

const FALLBACK_VERSION = "0.1.0";
let cachedVersion: string | null = null;

export async function getHarnessVersion(): Promise<string> {
	if (cachedVersion) return cachedVersion;

	// npm/yarn/bun run can inject this; compiled binary usually cannot.
	// biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket access
	const envVersion = process.env["npm_package_version"];
	if (typeof envVersion === "string" && envVersion.trim().length > 0) {
		cachedVersion = envVersion.trim();
		return cachedVersion;
	}

	try {
		const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as PackageLike;
		if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
			cachedVersion = pkg.version.trim();
			return cachedVersion;
		}
	} catch {
		// fall through to fallback
	}

	cachedVersion = FALLBACK_VERSION;
	return cachedVersion;
}
