# Design decisions

Copilot Gateway separates client authentication, GitHub credentials, upstream transport, model discovery, admission control, and protocol handling. Each component has a bounded lifecycle and can be tested with fixture transports.

| Component             | Behavior                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Client authentication | A required gateway key authenticates API access; credentials are never served over HTTP                            |
| Device login          | Cancellable polling handles expiry, authorization denial, and slowdown                                             |
| Credentials           | Owner-only persistence and shared on-demand refresh with lifetime awareness and failure cooldown                   |
| Upstream routing      | Explicit environment override, then credential-provided origin, then account-plan defaults                         |
| Models                | Current catalog IDs, policy checks, supported endpoints, and explicit aliases                                      |
| Admission             | Bounded concurrency and atomic pacing; excess work receives 429                                                    |
| Requests              | Runtime envelope validation, byte limits, cancellation, and total deadlines                                        |
| Native protocols      | Messages, Responses, Chat Completions, and embeddings preserve evolving fields and events                          |
| Messages fallback     | Supported text/image/tool requests translate to Chat; unsupported features return useful errors                    |
| Tool streams          | Native events pass through; fallback fragments accumulate independently and emit valid ordered blocks              |
| Retry policy          | Safe reads may retry transient failures; generations retry explicit rate-limit refusals and refresh once after 401 |
| Token counting        | Native counter when available; clearly labelled local estimates otherwise                                          |
| Observability         | Request metadata and aggregate metrics; prompt/tool payloads and credentials stay out of logs                      |
| Containers            | Runtime-only credentials, unprivileged image, persistent login volume, amd64 and arm64 releases                    |
| Configuration         | Environment overrides work locally and in Docker; startup validates values                                         |

This gateway serves one Copilot account. Clients own MCP connections and tool execution. Models retain their supported protocols; incompatible endpoints receive an actionable error. Upstream capability and entitlement errors pass through so clients can recover where supported.

Passing fixture tests establishes the exercised protocol contracts. Live account verification establishes access only for the tested account, model, and operation. See [verification](upstream.md) for those results and limits.
