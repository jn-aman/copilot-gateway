# Upstream verification

Checked on 2026-10-04. Source evidence and a live account check are different forms of evidence.

## Current source evidence

- Microsoft's [credential type](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/authentication/common/copilotToken.ts) includes `endpoints.api`; [domain handling](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/node/domainServiceImpl.ts) updates domains from credentials. The gateway validates that origin before sending a credential.
- [OpenCode model discovery](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/github-copilot/models.ts) reads `supported_endpoints`, policy, streaming, tool, vision, reasoning, and model limits. It selects the native Messages protocol for models advertising `/v1/messages` and Responses for models advertising `/responses`.
- [OpenCode transport](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/github-copilot/copilot.ts) uses API version `2026-06-01`, detects initiation from the latest turn, and recognizes images nested in tool results. This gateway makes the API version configurable and applies the same turn-level distinction.
- Microsoft's [extension manifest](https://github.com/microsoft/vscode-copilot-chat/blob/main/package.json) read during the check reported plugin version 0.44.0 and VS Code engine floor 1.115.0. They supply configurable compatibility defaults, not a claim that those are today's newest VS Code binaries.
- [Claude Code's gateway contract](https://code.claude.com/docs/en/llm-gateway-protocol) calls Messages (including `?beta=true`), describes optional counting, native stream fidelity, open header/body forwarding, capability-rejection recovery, rate-limit hints and model discovery. [Connection guidance](https://code.claude.com/docs/en/llm-gateway-connect) and [environment variables](https://code.claude.com/docs/en/env-vars) inform the launcher.
- [GitHub's public Copilot REST API](https://docs.github.com/en/rest/copilot) documents management/monitoring. The private inference paths are not a supported public inference contract. [GitHub's device authorization flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) documents polling, expiry, denial and slowdown.
- [Bun HTTP server documentation](https://bun.sh/docs/runtime/http/server) documents per-request idle timeouts and shutdown. Inference disables Bun's idle limit and uses an application deadline instead.
- [typescript-eslint's supported compiler range](https://typescript-eslint.io/users/dependency-versions/) excludes TypeScript 7 at the time of inspection. The latest TypeScript compiler is used for checking; [Oxlint](https://oxc.rs/docs/guide/usage/linter.html) handles linting without that compiler API dependency.

## Local interoperability evidence

The test suite runs the current installed OpenAI and Anthropic SDKs against fixture transports. It also runs the installed Claude Code 2.1.282 against a real local HTTP gateway with an isolated configuration and verifies streamed Bash `pwd` and MCP tool calls, returned results, and final answers. MCP tests use the official TypeScript SDK 1.32.0 to provide a real stdio tool server. An additional OpenAI client test independently verifies MCP discovery, execution and the Chat Completions tool/result round trip without Claude Code. This proves the exercised client flows and gateway contracts locally. It does not prove every provider feature.

## Live account check

A classic personal access token authenticated successfully with GitHub `/user` but not with Copilot inference. Token exchange returned HTTP 404. Direct Copilot `/models` calls with both `2025-04-01` and `2026-06-01` API versions returned HTTP 400 stating that personal access tokens are unsupported.

With device OAuth, token exchange and model discovery succeeded. A Copilot Free test account returned enabled catalog entries that inference still rejected. Catalog policy flags alone were not sufficient evidence of inference access.

| Probe                                                           | Live result                                                                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Chat Completions, `gpt-4.1`                                     | HTTP 200, nonstream answer                                                                                                        |
| Chat Completions, `gpt-4.1-2025-04-14`                          | Successful streamed forced function call, returned tool result, and streamed final acknowledgement through the current OpenAI SDK |
| Embeddings, `text-embedding-3-small`                            | Successful 1536-dimension result through the OpenAI SDK using an array of text inputs and float encoding                          |
| Native Messages, `claude-haiku-4.5`                             | HTTP 400 `model_not_supported`, despite an enabled catalog entry advertising Messages                                             |
| Responses, `gpt-5-mini`, `gpt-6-luna`, `gpt-5.4-mini-free-auto` | HTTP 400 `model_not_supported`                                                                                                    |

Live checks exposed wire differences and supplied regression cases: intermediate Chat deltas omit `finish_reason`; completed tool calls can use `stop`; embedding responses can contain only `data` and `usage`. The gateway supplies null intermediate finish reasons, uses `tool_calls` when completed calls end with `stop`, and supplies missing OpenAI embedding envelope fields. It preserves explicit truncation/refusal reasons. Both streaming and nonstream Messages translation use `tool_use` for the same completed-tool case. Native field passthrough and custom-tool handling remain covered by fixtures.

`bun run test:live` checks each protocol independently and exits nonzero for any rejection or verification failure. Its final run passed Chat tools and embeddings and reported account-level Messages/Responses refusals. Native Messages/Responses and Claude Code MCP compatibility are verified locally; live native Claude/Responses success cannot be claimed for this account.

## Container and VM verification

The Bun 1.4.2 runtime image built successfully on Linux arm64. Its build runs strict types, lint, formatting, tests and bundling. The container E2E checker runs the compiled entry point with an externally mounted test transport over real HTTP. It verifies headless device login into a named volume, restarting with the saved owner-only credential on a read-only mount, non-root/read-only runtime operation, authenticated APIs, streamed Chat and Messages, Responses, embeddings, native and estimated counting, usage, metrics, model gates, rate-limit retry, real MCP tool discovery/execution/results, and graceful shutdown. The test transport is excluded from the final image.

A separate production container used runtime-only OAuth credential injection and real Copilot inference: GPT-4.1 completed a streamed function-call/result round trip and embeddings returned 1536 dimensions. That container shut down successfully. No live credentials were added to an image or Git history.

The CI and release workflows validate Linux amd64 and arm64 independently. Release publication is gated on those checks. Images include source/license metadata, provenance and an SBOM; GitHub release assets include public, loadable architecture-specific Docker archives and checksums. The documented VM flow prints a device code and supports authorization in a browser on a different computer.

No inference is issued before successful credential/model discovery. Private API access cannot be inferred from a valid generic GitHub credential or a Copilot subscription alone. Device OAuth login is the normal path when token exchange rejects a personal access token.
