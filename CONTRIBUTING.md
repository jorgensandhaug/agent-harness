# Contributing

## Development Setup

1. Install Bun (1.2+ recommended).
2. Install dependencies:

```bash
bun install
```

3. Run tests:

```bash
bun test
```

## Pull Requests

- Keep PRs focused and small when possible.
- Add tests for behavior changes.
- Update docs when user-facing behavior changes.
- Keep CLI/API parity when changing HTTP API behavior.

## Dependency License Inventory

Generate the dependency license inventory at:

`docs/licenses/dependency-license-inventory.json`

Command:

```bash
bun run licenses:inventory
```
