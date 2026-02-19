# Agent Instructions

## Non-Negotiable CLI/API Parity Rules

1. The CLI in `src/cli/` MUST be a complete mirror of the HTTP API in `src/api/`.
2. Every API endpoint, request parameter, query parameter, and option must have corresponding CLI coverage.
3. When adding or modifying any API endpoint, update the corresponding CLI command in the same commit/PR.
4. When adding new API parameters, also add:
   - CLI flags/options
   - config-file support in `src/cli/config.ts` when defaultable
   - environment variable support when defaultable
5. Keep `src/cli/config.ts` schema and runtime resolution in sync with all defaultable CLI options.
6. Run `ah --help` (and relevant subcommand help) before committing to verify new flags are exposed.

## CLI/API Parity Checklist

- [ ] Enumerate changed routes in `src/api/` (method + path + path params + query + body).
- [ ] Confirm a dedicated command flow exists in `src/cli/commands/` for each route.
- [ ] Confirm `src/cli/http-client.ts` exposes a typed method for each endpoint used by commands.
- [ ] Add/update CLI flags for every API parameter.
- [ ] For defaultable options: update `src/cli/config.ts` schema + resolver + env vars.
- [ ] Add/update tests for new flags, parameter mapping, and config/env precedence.
- [ ] Verify help output includes new flags: `ah --help` and relevant `ah <group> <cmd> --help`.
- [ ] Keep API and CLI changes in the same commit/PR.
