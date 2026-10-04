import type { Fetcher } from "~/auth"
import type { Config } from "~/config"

import { TokenManager, githubJson } from "~/auth"
import { GatewayError } from "~/errors"
import { readText } from "~/io"
import { withSignal } from "~/lifecycle"
import { fetchWithRetry, retryDelay } from "~/retry"

export interface Upstream {
  readonly ready: boolean
  request(
    path: string,
    payload: Record<string, unknown> | undefined,
    signal: AbortSignal,
    requestId: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response>
  usage(signal: AbortSignal): Promise<unknown>
}

export class CopilotUpstream implements Upstream {
  private readonly tokens: TokenManager
  private readonly baseUrl: string
  private retries = 0

  constructor(
    private readonly config: Config,
    private readonly githubToken: string,
    private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
  ) {
    this.tokens = new TokenManager(githubToken, fetcher, Date.now, config)
    this.baseUrl =
      config.ACCOUNT_TYPE === "individual"
        ? "https://api.githubcopilot.com"
        : `https://api.${config.ACCOUNT_TYPE}.githubcopilot.com`
  }

  get ready() {
    return this.tokens.ready
  }
  get retryCount() {
    return this.retries
  }

  async request(
    path: string,
    payload: Record<string, unknown> | undefined,
    signal: AbortSignal,
    requestId: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    try {
      let token = await withSignal(this.tokens.get(), signal)
      signal.throwIfAborted()
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: payload?.stream ? "text/event-stream" : "application/json",
        "copilot-integration-id": this.config.COPILOT_INTEGRATION_ID,
        "editor-version": `vscode/${this.config.EDITOR_VERSION}`,
        "editor-plugin-version": `copilot-chat/${this.config.PLUGIN_VERSION}`,
        "user-agent": `GitHubCopilotChat/${this.config.PLUGIN_VERSION}`,
        "openai-intent": this.config.COPILOT_INTENT,
        "x-github-api-version": this.config.COPILOT_API_VERSION,
        "x-request-id": requestId,
        "x-interaction-type": this.config.COPILOT_INTERACTION_TYPE,
        ...extraHeaders,
      }
      const entries = Array.isArray(payload?.messages)
        ? payload.messages
        : Array.isArray(payload?.input)
          ? payload.input
          : []
      const last = entries.at(-1) as
        { role?: string; content?: unknown } | undefined
      const onlyToolResults =
        Array.isArray(last?.content) &&
        last.content.length > 0 &&
        last.content.every(
          (part: unknown) =>
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "tool_result",
        )
      headers["x-initiator"] =
        typeof payload?.input === "string" ||
        (last?.role === "user" && !onlyToolResults)
          ? "user"
          : "agent"
      if (hasImage(entries)) headers["copilot-vision-request"] = "true"
      const init: RequestInit & { signal: AbortSignal } = {
        method: payload ? "POST" : "GET",
        headers,
        body: payload ? JSON.stringify(payload) : undefined,
        signal,
        redirect: "error",
      }
      const send = () =>
        fetchWithRetry(
          this.fetcher,
          `${this.config.COPILOT_API_URL ?? this.tokens.apiHost ?? this.baseUrl}${path}`,
          init,
          {
            retries: this.config.MAX_RETRIES,
            maxDelayMs: this.config.MAX_RETRY_DELAY_MS,
            onRetry: () => {
              this.retries++
            },
          },
        )
      let response = await send()
      if (response.status === 401) {
        await response.body?.cancel()
        this.tokens.invalidate(token)
        token = await withSignal(this.tokens.get(), signal)
        headers.authorization = `Bearer ${token}`
        this.retries++
        response = await send()
      }
      if (!response.ok) {
        if (response.status === 401) this.tokens.invalidate(token)
        const retryAfter = response.headers.get("retry-after")
        let body: unknown
        let detail: string | undefined
        try {
          const encoded = (await readText(response.body, 1048576, signal, true))
            .replaceAll(token, "[REDACTED]")
            .replaceAll(this.githubToken, "[REDACTED]")
          try {
            body = JSON.parse(encoded) as unknown
          } catch {
            detail = encoded.trim().slice(0, 2048) || undefined
          }
        } catch {
          if (signal.aborted) throw signal.reason
        }
        const forwarded = responseHeaders(response.headers)
        if (response.status === 429)
          throw new GatewayError(
            429,
            "rate_limit_error",
            detail ?? "Copilot rate limit reached",
            String(Math.max(1, Math.ceil(retryDelay(retryAfter, 0) / 1000))),
            body,
            forwarded,
          )
        throw new GatewayError(
          response.status,
          response.status < 500 ? "invalid_request_error" : "api_error",
          detail ?? `Copilot rejected this request (${response.status})`,
          undefined,
          body,
          forwarded,
        )
      }
      return response
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof GatewayError) throw error
      throw new GatewayError(502, "api_error", "Could not reach Copilot")
    }
  }

  usage(signal: AbortSignal) {
    return githubJson(
      "/copilot_internal/user",
      this.githubToken,
      signal,
      this.fetcher,
      this.config,
    )
  }
}

function hasImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasImage)
  if (typeof value !== "object" || value === null) return false
  const part = value as Record<string, unknown>
  return (
    ["image", "image_url", "input_image"].includes(String(part.type)) ||
    (Array.isArray(part.content) && hasImage(part.content))
  )
}

export function responseHeaders(source: Headers): Headers {
  const headers = new Headers()
  for (const [name, value] of source) {
    if (
      name === "x-should-retry" ||
      name === "request-id" ||
      name.startsWith("anthropic-ratelimit-")
    )
      headers.set(name, value)
  }
  return headers
}
