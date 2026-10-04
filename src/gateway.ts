import { timingSafeEqual } from "node:crypto"
import { encode } from "gpt-tokenizer"
import { z } from "zod"

import type { Config } from "~/config"
import type { Upstream } from "~/upstream"

import { GatewayError, normalizeError } from "~/errors"
import { encodeEvent, readJson } from "~/io"
import { Admission, requestScope, withSignal } from "~/lifecycle"
import { ModelCatalog } from "~/models"
import { toAnthropic, toOpenAI } from "~/protocols/anthropic"
import {
  chatSchema,
  completionSchema,
  nativeCompletionSchema,
  embeddingsSchema,
  messagesSchema,
  nativeCountSchema,
  nativeMessagesSchema,
  responsesSchema,
  nativeMessageResponseSchema,
  nativeResponseSchema,
  embeddingResponseSchema,
} from "~/protocols/schemas"
import {
  anthropicStream,
  nativeStream,
  openaiStream,
} from "~/protocols/streams"
import { responseHeaders } from "~/upstream"

type Protocol = "openai" | "messages" | "responses"
export interface RequestLog {
  requestId: string
  method: string
  route: string
  status: number
  durationMs: number
}
const knownPaths = new Set([
  "/",
  "/healthz",
  "/readyz",
  "/metrics",
  "/usage",
  "/api/hello",
  "/v1/models",
  "/models",
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/v1/responses",
  "/responses",
  "/v1/embeddings",
  "/embeddings",
])

export class Gateway {
  readonly catalog: ModelCatalog
  private readonly admission: Admission
  private readonly controllers = new Set<ReturnType<typeof requestScope>>()
  private readonly metrics = {
    requests: 0,
    errors: 0,
    streamErrors: 0,
    completed: 0,
    totalDurationMs: 0,
  }
  private readonly startedAt = Date.now()
  private countEndpointAvailable: boolean | undefined

  constructor(
    private readonly config: Config,
    private readonly upstream: Upstream,
    private readonly log: (entry: RequestLog) => void = (entry) =>
      console.log(JSON.stringify(entry)),
  ) {
    this.admission = new Admission(
      config.MAX_CONCURRENT_REQUESTS,
      config.MIN_REQUEST_INTERVAL_MS,
    )
    this.catalog = new ModelCatalog(upstream, config)
  }

  drain() {
    this.admission.drain()
  }
  abort() {
    for (const scope of this.controllers) scope.abort()
  }
  get active() {
    return this.controllers.size
  }

  async handle(request: Request, onBodyRead?: () => void): Promise<Response> {
    const requestId = crypto.randomUUID()
    const url = new URL(request.url)
    const path = url.pathname
    const protocol: Protocol = path.startsWith("/v1/messages")
      ? "messages"
      : path.endsWith("/responses")
        ? "responses"
        : "openai"
    const scope = requestScope(request.signal, this.config.REQUEST_TIMEOUT_MS)
    this.controllers.add(scope)
    this.metrics.requests++
    const started = Date.now()
    let release = () => {}
    let finished = false
    const finish = (status: number, streamError = false) => {
      if (finished) return
      finished = true
      release()
      scope.dispose()
      this.controllers.delete(scope)
      const durationMs = Date.now() - started
      this.metrics.completed++
      this.metrics.totalDurationMs += durationMs
      if (status >= 400) this.metrics.errors++
      if (streamError) this.metrics.streamErrors++
      if (this.config.LOG_REQUESTS === "true")
        this.log({
          requestId,
          method: request.method,
          route: knownPaths.has(path) ? path : "unknown",
          status,
          durationMs,
        })
    }
    const json = (body: unknown, status = 200, headers = new Headers()) => {
      headers.set("x-request-id", requestId)
      headers.set("cache-control", "no-store")
      finish(status)
      return Response.json(body, { status, headers })
    }
    try {
      if ((path === "/healthz" || path === "/") && request.method === "GET")
        return json({ status: "ok", service: "copilot-gateway" })
      this.authorize(request)
      if (!knownPaths.has(path))
        throw new GatewayError(404, "not_found_error", "Endpoint not found")
      if (path === "/api/hello" && request.method === "HEAD") {
        finish(200)
        return new Response(null, { headers: { "x-request-id": requestId } })
      }
      if (request.method === "GET") {
        if (path === "/readyz") {
          if (this.admission.snapshot.draining)
            return json({ status: "unavailable" }, 503)
          // Probe discovery when credentials expire, without issuing inference.
          if (!this.upstream.ready) {
            try {
              await this.catalog.list(scope.signal, true)
            } catch {
              return json({ status: "unavailable" }, 503)
            }
          }
          const ready = this.upstream.ready && !this.admission.snapshot.draining
          return json(
            { status: ready ? "ready" : "unavailable" },
            ready ? 200 : 503,
          )
        }
        if (path === "/metrics")
          return json({
            ...this.metrics,
            ...this.admission.snapshot,
            inFlight: this.active - 1,
            uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
            upstreamRetries:
              "retryCount" in this.upstream
                ? this.upstream.retryCount
                : undefined,
          })
        if (path === "/usage") {
          release = this.admission.acquire()
          return json(
            await withSignal(this.upstream.usage(scope.signal), scope.signal),
          )
        }
        if (path === "/v1/models" || path === "/models") {
          const catalog = await this.catalog.list(scope.signal)
          const data = catalog.data
            .filter((model) => model.policy?.state !== "disabled")
            .map((model) => ({
              ...model,
              object: "model",
              created: 0,
              owned_by: "github-copilot",
              display_name: model.name ?? model.id,
            }))
          return json({
            ...catalog,
            object: "list",
            data,
            has_more: false,
            first_id: data[0]?.id ?? null,
            last_id: data.at(-1)?.id ?? null,
          })
        }
      }
      if (request.method !== "POST")
        throw new GatewayError(
          405,
          "invalid_request_error",
          "Method not allowed",
        )
      if (
        ![
          "/v1/chat/completions",
          "/chat/completions",
          "/v1/messages",
          "/v1/messages/count_tokens",
          "/v1/responses",
          "/responses",
          "/v1/embeddings",
          "/embeddings",
        ].includes(path)
      )
        throw new GatewayError(
          405,
          "invalid_request_error",
          "Method not allowed",
        )
      if (
        request.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new GatewayError(
          415,
          "invalid_request_error",
          "Content-Type must be application/json",
        )
      const raw = await readJson(
        request.body,
        this.config.MAX_BODY_BYTES,
        scope.signal,
      )
      onBodyRead?.()
      let payload: Record<string, unknown>
      let endpoint: string
      let translated = false
      if (path === "/v1/messages/count_tokens") {
        payload = this.parse(nativeCountSchema, raw)
        const model = await this.catalog.resolve(
          String(payload.model),
          scope.signal,
        )
        payload.model = model.id
        release = this.admission.acquire()
        if (
          model.supported_endpoints?.includes("/v1/messages") &&
          this.countEndpointAvailable !== false
        ) {
          try {
            const response = await this.upstream.request(
              "/v1/messages/count_tokens",
              payload,
              scope.signal,
              requestId,
              anthropicHeaders(request),
            )
            const count = this.parse(
              z
                .object({ input_tokens: z.number().int().nonnegative() })
                .passthrough(),
              await readJson(response.body, 1048576, scope.signal, true),
              true,
            )
            this.countEndpointAvailable = true
            return json(count, 200, responseHeaders(response.headers))
          } catch (error) {
            if (
              !(error instanceof GatewayError) ||
              ![404, 405, 501].includes(error.status)
            )
              throw error
            this.countEndpointAvailable = false
          }
        }
        // No private count API is assumed. Mark the fallback explicitly.
        const count = encode(
          JSON.stringify({
            ...payload,
            max_tokens: undefined,
            stream: undefined,
            model: undefined,
          }),
        ).length
        return json(
          { input_tokens: count },
          200,
          new Headers({ "x-token-count-estimated": "true" }),
        )
      }
      if (path === "/v1/messages") {
        payload = this.parse(nativeMessagesSchema, raw)
        const model = await this.catalog.resolve(
          String(payload.model),
          scope.signal,
        )
        payload.model = model.id
        endpoint = model.supported_endpoints?.includes("/v1/messages")
          ? "/v1/messages"
          : "/chat/completions"
        if (endpoint === "/chat/completions") {
          payload = toOpenAI(this.parse(messagesSchema, payload))
          translated = true
        }
        this.catalog.validate(model, endpoint, payload)
      } else {
        const schema: z.ZodType<Record<string, unknown>> = path.endsWith(
          "/embeddings",
        )
          ? embeddingsSchema
          : protocol === "responses"
            ? responsesSchema
            : chatSchema
        payload = this.parse(schema, raw)
        endpoint = path.endsWith("/embeddings")
          ? "/embeddings"
          : protocol === "responses"
            ? "/responses"
            : "/chat/completions"
        const model = await this.catalog.resolve(
          String(payload.model),
          scope.signal,
        )
        payload.model = model.id
        this.catalog.validate(model, endpoint, payload)
      }
      release = this.admission.acquire()
      const response = await this.upstream.request(
        endpoint,
        payload,
        scope.signal,
        requestId,
        protocol === "messages" && !translated
          ? anthropicHeaders(request)
          : undefined,
      )
      if (!payload.stream) {
        let result = await readJson(
          response.body,
          this.config.MAX_RESPONSE_BYTES,
          scope.signal,
          true,
        )
        if (
          endpoint === "/embeddings" &&
          typeof result === "object" &&
          result !== null &&
          !Array.isArray(result)
        ) {
          // Copilot's embedding response omits these OpenAI envelope fields.
          const envelope = result as Record<string, unknown>
          result = { object: "list", model: payload.model, ...envelope }
        }
        if (!translated) {
          const schema: z.ZodType =
            endpoint === "/embeddings"
              ? embeddingResponseSchema
              : endpoint === "/v1/messages"
                ? nativeMessageResponseSchema
                : endpoint === "/responses"
                  ? nativeResponseSchema
                  : nativeCompletionSchema
          this.parse(schema, result, true)
          if (endpoint === "/chat/completions") {
            const completion = this.parse(nativeCompletionSchema, result, true)
            result = {
              ...completion,
              choices: completion.choices.map((choice) => ({
                ...choice,
                finish_reason:
                  choice.finish_reason === "stop" &&
                  Array.isArray(choice.message.tool_calls) &&
                  choice.message.tool_calls.length
                    ? "tool_calls"
                    : choice.finish_reason,
              })),
            }
          }
        }
        return json(
          translated
            ? toAnthropic(this.parse(completionSchema, result, true))
            : result,
          200,
          responseHeaders(response.headers),
        )
      }
      if (
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        await response.body?.cancel()
        throw new GatewayError(
          502,
          "api_error",
          "Copilot did not return an event stream",
        )
      }
      const iterator = translated
        ? anthropicStream(response.body, scope.signal, this.config)
        : protocol === "openai"
          ? openaiStream(
              response.body,
              scope.signal,
              typeof payload.n === "number" ? payload.n : 1,
              this.config.MAX_SSE_EVENT_BYTES,
            )
          : nativeStream(
              response.body,
              scope.signal,
              protocol,
              this.config.MAX_SSE_EVENT_BYTES,
            )
      const stream = this.streamResponse(
        iterator,
        response.body,
        scope,
        protocol,
        (status, error) => finish(status, error),
      )
      const headers = responseHeaders(response.headers)
      headers.set("content-type", "text/event-stream; charset=utf-8")
      headers.set("cache-control", "no-cache, no-transform")
      headers.set("x-accel-buffering", "no")
      headers.set("x-request-id", requestId)
      return new Response(stream, { headers })
    } catch (error) {
      const normalized = normalizeError(error, scope.signal)
      const headers = new Headers(normalized.headers)
      if (normalized.retryAfter)
        headers.set("retry-after", normalized.retryAfter)
      if (normalized.status === 401) headers.set("www-authenticate", "Bearer")
      if (normalized.status === 405)
        headers.set(
          "allow",
          [
            "/healthz",
            "/",
            "/readyz",
            "/metrics",
            "/usage",
            "/models",
            "/v1/models",
          ].includes(path)
            ? "GET"
            : "POST",
        )
      return json(
        normalized.body ?? errorBody(normalized, protocol),
        normalized.status,
        headers,
      )
    }
  }

  private authorize(request: Request) {
    const auth = request.headers.get("authorization")
    const bearer = auth?.match(/^Bearer (.+)$/i)?.[1]
    const key = request.headers.get("x-api-key")
    const expected = Buffer.from(this.config.GATEWAY_API_KEY)
    const valid = (value: string | null | undefined) => {
      if (!value) return false
      const candidate = Buffer.from(value)
      return (
        candidate.length === expected.length &&
        timingSafeEqual(candidate, expected)
      )
    }
    if (!valid(bearer) && !valid(key))
      throw new GatewayError(
        401,
        "authentication_error",
        "A valid gateway API key is required",
      )
  }

  private parse<T>(schema: z.ZodType<T>, raw: unknown, upstream = false): T {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      // Field paths explain validation failures without echoing prompt data.
      throw new GatewayError(
        upstream ? 502 : 400,
        upstream ? "api_error" : "invalid_request_error",
        `Invalid ${upstream ? "upstream response" : "request"}: ${parsed.error.issues.map((issue) => issue.path.join(".") || "body").join(", ")}`,
      )
    }
    return parsed.data
  }

  private streamResponse(
    iterator: AsyncGenerator<Uint8Array>,
    upstreamBody: ReadableStream<Uint8Array>,
    scope: ReturnType<typeof requestScope>,
    protocol: Protocol,
    finish: (status: number, error?: boolean) => void,
  ): ReadableStream<Uint8Array> {
    let closed = false
    let onAbort: () => void = () => {}
    const cleanup = () => {
      scope.signal.removeEventListener("abort", onAbort)
      void upstreamBody.cancel().catch(() => {})
    }
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          onAbort = () => {
            if (closed) return
            closed = true
            const error = normalizeError(scope.signal.reason, scope.signal)
            controller.enqueue(
              encodeEvent(
                errorBody(error, protocol),
                protocol === "openai" ? undefined : "error",
              ),
            )
            controller.close()
            cleanup()
            finish(error.status, true)
            void iterator.return(undefined).catch(() => {})
          }
          scope.signal.addEventListener("abort", onAbort, { once: true })
          if (scope.signal.aborted) onAbort()
        },
        pull: async (controller) => {
          if (closed) return
          try {
            const { value, done } = await withSignal(
              iterator.next(),
              scope.signal,
            )
            if (closed) return
            if (done) {
              closed = true
              controller.close()
              cleanup()
              finish(200)
            } else controller.enqueue(value)
          } catch (error) {
            if (closed) return
            closed = true
            const normalized = normalizeError(error, scope.signal)
            const body = normalized.body ?? errorBody(normalized, protocol)
            const eventType =
              typeof body === "object" &&
              body !== null &&
              "type" in body &&
              typeof body.type === "string"
                ? body.type
                : "error"
            controller.enqueue(
              encodeEvent(body, protocol === "openai" ? undefined : eventType),
            )
            controller.close()
            cleanup()
            finish(normalized.status, true)
            void iterator.return(undefined).catch(() => {})
          }
        },
        cancel: async () => {
          closed = true
          cleanup()
          scope.abort()
          finish(499, true)
          await iterator.return(undefined)
        },
      },
      { highWaterMark: 0 },
    )
  }
}

function errorBody(error: GatewayError, protocol: Protocol): unknown {
  const body = { error: { type: error.type, message: error.message } }
  return protocol === "openai" ? body : { type: "error", ...body }
}

function anthropicHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(
    [...request.headers].filter(
      ([name]) =>
        name.startsWith("anthropic-") || name.startsWith("x-claude-code-"),
    ),
  )
}
