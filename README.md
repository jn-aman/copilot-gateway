# Copilot Gateway

Use GitHub Copilot with OpenAI-compatible clients, Anthropic clients, and Claude Code. Supports Chat Completions, Responses, embeddings, streamed tool calls, and client-managed MCP tools.

## Run with Docker or on a VM

Requires Docker Compose. Download the configuration, create a private client key, and sign in:

```sh
curl -fsSLO https://raw.githubusercontent.com/jn-aman/copilot-gateway/main/compose.yaml
umask 077
openssl rand -hex 32 | sed 's/^/GATEWAY_API_KEY=/' > .env
docker compose run --rm gateway bun dist/main.js auth
```

Login prints a GitHub URL and code. Open the URL on **any computer**, enter the code, and authorize. The VM needs no browser or GitHub token environment variable. Credentials persist in a Docker volume.

Then start the server:

```sh
docker compose up -d
```

The gateway listens at `http://127.0.0.1:4141`. Keep `.env` and the credential volume when upgrading. To access a VM from your laptop, forward its port:

```sh
ssh -N -L 4141:127.0.0.1:4141 user@your-vm
```

## Connect your client

Use the `GATEWAY_API_KEY` value from `.env` as the client API key.

| Client                  | Base URL                   |
| ----------------------- | -------------------------- |
| OpenAI-compatible       | `http://127.0.0.1:4141/v1` |
| Anthropic / Claude Code | `http://127.0.0.1:4141`    |

For Claude Code, set `ANTHROPIC_BASE_URL` to the URL above, `ANTHROPIC_AUTH_TOKEN` to your gateway key, and `ANTHROPIC_MODEL` to a supported model ID. Existing MCP configuration stays with the client.

Get current model IDs from authenticated `GET /v1/models`. Choose the protocol the model supports: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, or `/v1/embeddings`. Actual access depends on Copilot entitlement; catalog entries alone do not guarantee inference access.

## Run from source

Requires Bun 1.3.9 or newer:

```sh
bun install --frozen-lockfile
bun run setup
bun start
```

With native Claude access and the Claude Code CLI installed, `bun run claude` starts both the gateway and Claude Code automatically.

All runtime settings can be overridden in `.env` or exported environment variables, including Docker Compose. See [configuration](docs/configuration.md).

[Operations](docs/operations.md) · [Release images](https://github.com/jn-aman/copilot-gateway/releases) · [Verification](docs/upstream.md) · [Design assessment](docs/assessment.md)

