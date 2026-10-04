# Working on Copilot Gateway

Use Bun and ESNext modules. Source imports use `~/*`. Strict TypeScript includes unchecked indexing and unused checks. Avoid `any`.

- `bun run check`: typecheck, lint, formatting, tests and build.
- `bun run dev`: watch mode.
- `bun run setup`: private credential setup and model discovery.
- `bun run claude`: launch Claude Code through the gateway.

Keep transport authentication separate from gateway client authentication. Never expose tokens, print bodies, add build-time credentials, or commit `.env`. Protocol passthrough must preserve evolving native fields and events. Test retries, cancellation, failure paths, and tool-call round trips when changing those owners. Never automatically replay an ambiguous generation or a started stream.

Use fixture transports in tests; do not access live credentials during the normal test suite. The Claude CLI integration test uses an isolated temporary config and a local fixture and skips if the CLI is unavailable. Live checks require explicit user authorization for the account being used.
