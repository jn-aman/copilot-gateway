# Operations guide

A local Copilot gateway for OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and embeddings. Native protocols preserve provider-specific reasoning, tools, caching metadata, and streamed events. Claude Code is one supported client; the server is independent of it.

This uses private GitHub Copilot inference APIs. It is an independent project, not a GitHub-supported inference API. Availability and accepted parameters depend on your subscription, organization policy, model, and upstream protocol.

## Start the gateway

Prerequisites: Bun 1.3.9 or newer and a GitHub account with Copilot access.

```sh
bun install --frozen-lockfile
bun run setup
bun start
```

`setup` creates a random gateway API key in an ignored `.env` with owner-only permissions, starts GitHub device login when necessary, and verifies model discovery for all supported protocols. Follow the displayed GitHub URL and code. The GitHub credential is saved outside the repository at `~/.local/share/copilot-gateway/github-token` (or beneath `XDG_DATA_HOME`). Device login requests only `read:user`. Neither `GH_TOKEN` nor `GITHUB_TOKEN` is required after login. Copilot rejects personal access tokens; adding PAT permissions does not authorize this private inference endpoint.

OpenAI clients use `base_url=http://127.0.0.1:4141/v1`; Anthropic clients use `base_url=http://127.0.0.1:4141`. Both authenticate with the generated **gateway key**, not the GitHub credential. Select a current model from the authenticated `/v1/models` endpoint. Server startup does not require a Claude model or any particular client CLI.

`bun run doctor` reports discovery by protocol without making a generation request. Catalog policy and endpoint metadata are not proof of live inference entitlement: a Free account can see enabled models that Copilot still rejects with `model_not_supported`. `bun run test:live` verifies access separately with bounded requests.

## Claude Code

Install the Claude Code CLI in PATH, then run `bun run claude`. Native Claude access must be available on your Copilot account.

`claude` starts a local server and launches your installed Claude Code CLI with the gateway URL and credential, policy-allowed native Sonnet/Haiku/Opus model IDs from the catalog, and gateway model discovery enabled. Copilot determines whether those IDs can actually generate. Gateway settings affect this child process. Your global Claude configuration is not edited. Claude Code arguments are forwarded:

```sh
bun run claude --print "Explain this repository"
```

Select the directory Claude Code should work on with `bun run claude --project /absolute/path/to/your/project`. Its MCP configuration, permissions and project settings apply there. Alternatively, start the gateway separately and configure a client in the desired project: set `ANTHROPIC_BASE_URL=http://127.0.0.1:4141`, `ANTHROPIC_AUTH_TOKEN` to the generated gateway key, and the `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL` variables to accessible IDs returned by `/v1/models`. Never point a client at the GitHub OAuth credential.

## MCP

MCP connections and tool execution belong to the MCP-capable client. For OpenAI clients, MCP tools travel as Chat/Responses tool definitions and results; for Anthropic clients, they travel as Messages tool definitions and results. The gateway preserves those native payloads and streams. No Claude dependency is required for these API operations.

Claude Code manages its own MCP connections. Its definitions, names, streamed input, structured results, images, error results, tool-reference blocks and deferred-tool fields pass through native Messages. Existing Claude Code MCP configuration continues to apply. The launcher forwards MCP options directly:

```sh
bun run claude --mcp-config /absolute/path/mcp.json
```

The test suite connects the real Claude Code CLI to a real local stdio MCP server using the current official MCP SDK and verifies discovery, execution, the returned tool result, and the final reply through the gateway. HTTP/SSE MCP connections, server authentication, resources and prompts remain managed by the client. The API gateway does not own a separate MCP connection registry or execute tools on your machine. See [Claude Code's MCP guide](https://code.claude.com/docs/en/mcp) for registering servers.

`bun run auth` explicitly repeats device login.

After device login, `bun run test:live` independently checks streamed Chat and Messages tool/result round trips, Responses streaming, and one embedding where advertised. Each refusal is recorded and gives a failing exit status; one protocol failure does not hide the others. Set `LIVE_CHAT_MODEL`, `LIVE_MESSAGE_MODEL`, `LIVE_RESPONSES_MODEL`, or `LIVE_EMBEDDING_MODEL` to choose exact catalog IDs. These requests use your Copilot account. Ordinary tests use fixtures only.

## API

Every endpoint except `/` and `/healthz` requires `Authorization: Bearer <gateway-key>` or `x-api-key: <gateway-key>`.

| Route                            | Behavior                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /v1/messages`              | Native Anthropic forwarding when the model advertises `/v1/messages`; chat translation otherwise |
| `POST /v1/messages/count_tokens` | Probes native token counting; falls back to a labelled local estimate on 404/405/501             |
| `POST /v1/chat/completions`      | OpenAI Chat Completions, including function/custom tools, structured output and trailing usage   |
| `POST /v1/responses`             | Native OpenAI Responses, including reasoning and function/custom tools                           |
| `POST /v1/embeddings`            | Native embeddings, dimensions, token inputs, and encoding options                                |
| `GET /v1/models`                 | Cached current model catalog, supported endpoints, limits, and display names                     |
| `GET /usage`                     | Upstream account usage                                                                           |
| `GET /healthz`                   | Public process liveness                                                                          |
| `GET /readyz`                    | Credential/discovery readiness and drain status                                                  |
| `GET /metrics`                   | Aggregate request, error, streaming, concurrency, and retry counters                             |
| `HEAD /api/hello`                | Claude Code connection-warming probe                                                             |

`/chat/completions`, `/models`, `/embeddings`, and `/responses` are also accepted. Query strings such as `/v1/messages?beta=true` do not affect routing.

For OpenAI clients, use `base_url=http://127.0.0.1:4141/v1` and the gateway key. Choose the operation the model advertises in `supported_endpoints`. Responses-only models require `responses.create`; their encrypted reasoning and stateful items cannot be losslessly converted to Chat Completions. Endpoint mismatches return an actionable 400 instead of silently changing protocols or models.

Native Messages passes evolving request body fields, `anthropic-*` headers, and `x-claude-code-*` headers through. Native streaming preserves thinking/signature deltas, interleaved tools, ping events, usage, and terminal events. Upstream error wording and retry/rate-limit hints are retained so Claude Code can recover from capability rejections. Credentials are redacted from upstream JSON errors.

Native Chat preserves evolving content parts, custom tools, provider reasoning and other fields. Copilot deltas that omit `finish_reason` receive the OpenAI-defined `null` value; every requested choice must finish before `[DONE]`. Completed tool calls ending with `stop` receive `tool_calls` (or `tool_use` for the Messages adapter), so clients execute them. Explicit truncation/refusal reasons survive. Embedding responses gain `object: "list"` and the requested model ID when Copilot omits those envelope fields. Plain-text upstream errors retain bounded, credential-redacted detail as well as JSON errors.

The fallback Messages-to-Chat adapter supports text, images, tools, structured tool results, stop sequences, and cached-input usage. Unsupported thinking/provider-specific fields return 400; it does not invent thinking signatures or silently drop unsupported features. In this fallback only, parallel tool arguments are buffered by tool index (maximum 4 MiB) and emitted as ordered blocks at completion. Text streams immediately. Claude Code uses native Messages through the launcher.

Token-count estimates use the tokenizer on the serialized request, including system, messages, and tools. `x-token-count-estimated: true` identifies estimates. They are not exact Claude token counts and do not validate context-window limits. Unknown model IDs never receive a fabricated token count.

## Configuration

Bun loads `.env` in the working directory. See [configuration](configuration.md) for all runtime and Docker overrides, precedence, and examples. [.env.example](../.env.example) lists the defaults. Environment configuration is validated at startup; bad values fail with field names without printing secret values.

Defaults: all-interface binding (`0.0.0.0`), port 4141, eight simultaneous upstream operations, no local pacing, a five-minute total request deadline (including streaming), a 4 MiB request-body limit, two transient retries, and a one-minute model cache. Change these for your subscription and workload. Requests exceeding capacity receive 429 and `Retry-After`; there is no unbounded waiting queue.

`GITHUB_TOKEN` overrides the credential file. `GITHUB_TOKEN_FILE` selects an existing private credential. `MODEL_ALIASES` maps explicit names to exact IDs, for example `{"my-claude":"<id-from-model-catalog>"}`. Model names are not rewritten with version-dependent regular expressions. Claude model selection follows accessible catalog IDs rather than a built-in model list.

Copilot token refresh is shared across callers, refreshes ahead of expiry, honors changed lifetimes, backs off on failure, and retains a still-valid credential during a temporary failure. An explicit `COPILOT_API_URL` wins over the API host supplied in credential metadata, which wins over account-type defaults. Configured endpoint origins must use HTTPS; set them only to services you trust with credentials. Automatically discovered hosts remain restricted to Copilot. Only discovered HTTPS origins under `githubcopilot.com`, without credentials, custom ports, paths or queries, are accepted. Redirects are rejected.

Retries use exponential jitter and honor numeric/date `Retry-After` values. Read requests retry network errors and 408/429/502/503/504. Generations retry explicit 429 rejection and refresh once after 401. An ambiguous generation network/5xx failure or an interrupted stream is never replayed by the gateway; the request may already have incurred work. Long cooldowns and `x-should-retry: false` are returned to clients. Retry waits are cancellable and share the request deadline.

Logs contain generated request IDs, known route names, status and duration. Prompt text, tool arguments, and credentials are not logged. Credentials are not served over HTTP. CORS is disabled. For remote deployment, terminate TLS in front of the gateway and keep the gateway key private. The credential belongs to one Copilot account; this is not a multi-tenant gateway.

SIGINT/SIGTERM stops new work, drains existing requests for `SHUTDOWN_GRACE_MS` (ten seconds by default), then aborts remaining work and closes the server.

## Container

Published images support Linux amd64 and arm64, including VMs. No Bun installation is required on the host. Create a private client key and a persistent credential volume:

```sh
umask 077
openssl rand -hex 32 | sed 's/^/GATEWAY_API_KEY=/' > .env
docker volume create copilot-gateway-data
docker run --rm -v copilot-gateway-data:/data \
  ghcr.io/jn-aman/copilot-gateway:latest bun dist/main.js auth
```

The login command prints a URL and device code. Open the URL in a browser on **any computer**, enter the code, and authorize GitHub. The headless VM polls until authorization succeeds and saves an owner-only OAuth credential in the mounted volume. No browser, PAT, `GH_TOKEN`, or `GITHUB_TOKEN` environment variable is needed on the VM. Repeat the same login command to replace a revoked credential.

Start the gateway using that volume:

```sh
docker run -d --name copilot-gateway --restart unless-stopped \
  --env-file .env -e HOST=0.0.0.0 --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true \
  -v copilot-gateway-data:/data:ro \
  -p 127.0.0.1:4141:4141 ghcr.io/jn-aman/copilot-gateway:latest
```

To reach a VM-bound gateway from your laptop, use `ssh -N -L 4141:127.0.0.1:4141 user@your-vm`, then point clients at `http://127.0.0.1:4141`. For shared remote access, configure a TLS reverse proxy and protect the client key. The supplied Compose file publishes on all interfaces. Set `GATEWAY_BIND_ADDRESS=127.0.0.1` for tunnel-only access:

```sh
docker compose run --rm gateway bun dist/main.js auth
docker compose up -d
```

Keep `.env` and the credential volume when restarting or upgrading. The image contains neither credential. A mounted volume is required for login persistence; credentials are never baked into images.

For local source builds and an existing host credential:

```sh
docker build -t copilot-gateway .
docker run --rm -p 127.0.0.1:4141:4141 \
  --env-file .env -e HOST=0.0.0.0 \
  -e GITHUB_TOKEN_FILE=/credentials/github-token \
  -v "$HOME/.local/share/copilot-gateway:/credentials:ro" \
  copilot-gateway
```

The container runs as the unprivileged Bun user (UID 1000); a host-mounted credential must be readable by that UID. Device login into the named volume handles ownership automatically. An OAuth `GITHUB_TOKEN` environment override remains available for runtime secret injection in managed deployments.

## Releases

Pushing a tag matching the package version, such as `v0.1.0`, runs the [release pipeline](../.github/workflows/release.yaml). Publication waits for Linux amd64 and arm64 validation, including the compiled container's HTTP APIs, headless login persistence and real MCP execution. It then publishes a multi-platform GHCR image with provenance and an SBOM, version/minor/commit tags, and `latest` for stable releases. GitHub releases include loadable Docker archives for each architecture and SHA-256 checksums.

The pipeline uses GitHub Actions' repository-scoped `GITHUB_TOKEN` with `packages: write` and `contents: write`. This is separate from runtime Copilot authentication. No publisher PAT or Copilot secret is needed in Actions.

GitHub defaults newly created GHCR packages to private. The package owner must set its visibility to **Public** once in [package settings](https://github.com/users/jn-aman/packages/container/copilot-gateway/settings) for anonymous registry pulls. Public [release archives](https://github.com/jn-aman/copilot-gateway/releases) work without registry login regardless of that setting: download the archive for your architecture, verify it with `sha256sum --check SHA256SUMS --ignore-missing`, then use `docker load --input copilot-gateway-<version>-<arch>.tar.gz`. The imported image tag ends with the architecture; use that tag in the commands above.

## Development and evidence

```sh
bun run check
docker build -t copilot-gateway:test .
bun run test:container
```

Checks include strict TypeScript, lint, formatting, Bun tests, and an ESM build. Tests cover credentials, host validation, retries, admission, request cancellation, fragmented UTF-8/SSE/tools, model routing, upstream errors, native protocols and current OpenAI/Anthropic SDK clients. An OpenAI client discovers and executes a real stdio MCP tool through Chat Completions. When Claude Code is installed, the suite launches it against a local fixture and verifies actual streamed Bash and MCP tool-call/result round trips in isolated temporary directories. CI skips those two tests when the CLI is absent. Fixtures require no live account.

The dependency lockfile records the latest npm releases installed during this rebuild. TypeScript 7 removed `baseUrl`; path mappings use explicit relative targets. Oxlint avoids the current TypeScript compiler API mismatch with typescript-eslint.

Container checks run the actual compiled entry point with a test-only transport mounted through Bun's preload facility. They verify APIs over real HTTP, owner-only headless credential persistence across separate login/server containers, read-only filesystem operation, non-root execution, protocol streaming, MCP discovery/execution/results, rate-limit retry, and graceful shutdown. The test transport is neither bundled nor copied into the production image and makes no live requests. Live Copilot checks remain separate.

[Assessment](assessment.md) records what was kept, replaced, and intentionally excluded. [Upstream findings](upstream.md) records the source evidence and the limits of live verification.

