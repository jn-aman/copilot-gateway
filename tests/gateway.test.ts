import { describe, expect, test } from "bun:test"

import { GatewayError } from "~/errors"
import { Gateway } from "~/gateway"
import { withSignal } from "~/lifecycle"

import { apiKey, chunk, config, FakeUpstream, request, sse } from "./helpers"

const chat = { model: "chat-test", messages: [{ role: "user", content: "Hi" }] }
const messages = {
  model: "claude-sonnet-4.6",
  max_tokens: 64,
  messages: [{ role: "user", content: "Hi" }],
}
const make = (options: Record<string, string> = {}) => {
  const upstream = new FakeUpstream()
  const logs: unknown[] = []
  const gateway = new Gateway(config(options), upstream, (entry) =>
    logs.push(entry),
  )
  return { gateway, upstream, logs }
}

describe("authentication and routing", () => {
  test("health is public; model discovery requires a key", async () => {
    const { gateway, upstream } = make()
    expect(
      (await gateway.handle(new Request("http://localhost/healthz"))).status,
    ).toBe(200)
    expect(
      (await gateway.handle(new Request("http://localhost/v1/models"))).status,
    ).toBe(401)
    expect(upstream.calls).toHaveLength(0)
  })
  test("Anthropic keys and case-insensitive bearer schemes work", async () => {
    const { gateway } = make()
    expect(
      (
        await gateway.handle(
          request("/v1/models", undefined, {
            authorization: "invalid",
            "x-api-key": apiKey,
          }),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await gateway.handle(
          request("/v1/models", undefined, {
            authorization: `bearer ${apiKey}`,
          }),
        )
      ).status,
    ).toBe(200)
  })
  test("tokens are never served and browser access is not implicitly enabled", async () => {
    const { gateway } = make()
    const response = await gateway.handle(request("/token"))
    expect(response.status).toBe(404)
    expect(response.headers.has("access-control-allow-origin")).toBeFalse()
  })
  test("Claude warm-up probe is accepted", async () => {
    const { gateway } = make()
    expect(
      (
        await gateway.handle(
          new Request("http://localhost/api/hello", {
            method: "HEAD",
            headers: { "x-api-key": apiKey },
          }),
        )
      ).status,
    ).toBe(200)
  })
  test("method errors do not parse bodies", async () => {
    const { gateway } = make()
    const response = await gateway.handle(request("/v1/chat/completions"))
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
  })
})

describe("validation and models", () => {
  test("invalid JSON fails before upstream traffic", async () => {
    const { gateway, upstream } = make()
    const response = await gateway.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: "{",
      }),
    )
    expect(response.status).toBe(400)
    expect(upstream.calls).toHaveLength(0)
  })
  test("size limits work on streamed bodies without content-length", async () => {
    const { gateway } = make({ MAX_BODY_BYTES: "1024" })
    expect(
      (
        await gateway.handle(
          request("/v1/chat/completions", { ...chat, extra: "x".repeat(2000) }),
        )
      ).status,
    ).toBe(413)
  })
  test("media types and malformed messages fail explicitly", async () => {
    const { gateway } = make()
    expect(
      (
        await gateway.handle(
          request("/v1/chat/completions", chat, {
            "content-type": "text/plain",
          }),
        )
      ).status,
    ).toBe(415)
    expect(
      (
        await gateway.handle(
          request("/v1/chat/completions", {
            model: "chat-test",
            messages: [{ role: "tool", content: "result" }],
          }),
        )
      ).status,
    ).toBe(400)
  })
  test("explicit model aliases preserve new model IDs", async () => {
    const { gateway, upstream } = make({
      MODEL_ALIASES: '{"custom":"chat-test"}',
    })
    expect(
      (
        await gateway.handle(
          request("/v1/chat/completions", { ...chat, model: "custom" }),
        )
      ).status,
    ).toBe(200)
    expect(upstream.calls.at(-1)?.payload?.model).toBe("chat-test")
  })
  test("unknown and disabled models fail before generation", async () => {
    const { gateway, upstream } = make()
    expect(
      (
        await gateway.handle(
          request("/v1/chat/completions", { ...chat, model: "unknown" }),
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await gateway.handle(
          request("/v1/chat/completions", { ...chat, model: "disabled" }),
        )
      ).status,
    ).toBe(403)
    expect(upstream.calls.every((call) => call.path === "/models")).toBeTrue()
  })
  test("endpoint and capability checks reject incompatible operations", async () => {
    const { gateway } = make()
    expect(
      (
        await gateway.handle(
          request("/v1/chat/completions", { ...chat, model: "response-test" }),
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await gateway.handle(
          request("/v1/chat/completions", { ...chat, max_tokens: 4097 }),
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await gateway.handle(
          request("/v1/chat/completions", {
            ...chat,
            model: "no-tools",
            stream: true,
          }),
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await gateway.handle(
          request("/v1/chat/completions", {
            ...chat,
            model: "no-tools",
            tools: [{ type: "function", function: { name: "tool" } }],
          }),
        )
      ).status,
    ).toBe(400)
  })
  test("discovery is cached, filters disabled models, and has Claude display names", async () => {
    const { gateway, upstream } = make()
    const first = (await (
      await gateway.handle(request("/v1/models?limit=1000"))
    ).json()) as { data: Array<{ id: string; display_name: string }> }
    await gateway.handle(request("/models"))
    expect(upstream.calls).toHaveLength(1)
    expect(first.data.some((model) => model.id === "disabled")).toBeFalse()
    expect(
      first.data.find((model) => model.id === "claude-sonnet-4.6")
        ?.display_name,
    ).toBe("Claude Sonnet")
  })
})

describe("native Claude and Responses operations", () => {
  test("Claude Code blocks, cache metadata, betas, thinking and new fields pass through", async () => {
    const { gateway, upstream } = make()
    const payload = {
      ...messages,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: "system",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      tools: [
        { name: "tool", input_schema: { type: "object" }, defer_loading: true },
      ],
      future_field: { enabled: true },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private", signature: "signature" },
            { type: "tool_use", id: "tool-1", name: "tool", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [{ type: "text", text: "result" }],
            },
          ],
        },
      ],
    }
    const response = await gateway.handle(
      request("/v1/messages?beta=true", payload, {
        "anthropic-beta": "new-beta,interleaved-thinking",
        "anthropic-version": "2023-06-01",
        "anthropic-future-header": "future",
        "x-claude-code-agent-id": "agent-1",
      }),
    )
    expect(response.status).toBe(200)
    expect(upstream.calls.at(-1)?.path).toBe("/v1/messages")
    expect(upstream.calls.at(-1)?.payload).toEqual({
      ...payload,
      stream: false,
    })
    expect(upstream.calls.at(-1)?.headers).toEqual({
      "anthropic-beta": "new-beta,interleaved-thinking",
      "anthropic-version": "2023-06-01",
      "anthropic-future-header": "future",
      "x-claude-code-agent-id": "agent-1",
    })
  })
  test("native thinking, signature, tool fragments, ping and usage events are preserved", async () => {
    const { gateway, upstream } = make()
    const events = [
      { type: "message_start", message: { id: "msg-1" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "reason" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "ping" },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tool-1",
          name: "Bash",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"command":' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"pwd"}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 42 },
      },
      { type: "message_stop" },
    ]
    upstream.respond = () => sse(events, 1)
    const response = await gateway.handle(
      request("/v1/messages", { ...messages, stream: true }),
    )
    const text = await response.text()
    const actual = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as unknown)
    expect(actual).toEqual(events)
    expect(gateway.active).toBe(0)
  })
  test("Responses encrypted reasoning and custom tools are passed through", async () => {
    const { gateway, upstream } = make()
    const payload = {
      model: "response-test",
      input: [
        { type: "function_call_output", call_id: "call", output: "done" },
        { type: "reasoning", encrypted_content: "opaque" },
      ],
      tools: [{ type: "custom", name: "edit" }],
      reasoning: { effort: "high" },
      previous_response_id: "previous",
      store: false,
    }
    expect(
      (await gateway.handle(request("/v1/responses", payload))).status,
    ).toBe(200)
    expect(upstream.calls.at(-1)?.payload).toEqual({
      ...payload,
      stream: false,
    })
  })
  test("Responses streams preserve function-call and reasoning events through completion", async () => {
    const { gateway, upstream } = make()
    const events = [
      { type: "response.created", response: { id: "resp" } },
      { type: "response.reasoning_summary_text.delta", delta: "reason" },
      { type: "response.function_call_arguments.delta", delta: "{}" },
      {
        type: "response.completed",
        response: { id: "resp", status: "completed" },
      },
    ]
    upstream.respond = () => sse(events)
    const response = await gateway.handle(
      request("/v1/responses", {
        model: "response-test",
        input: "hi",
        stream: true,
      }),
    )
    const body = await response.text()
    expect(body).toContain("event: response.function_call_arguments.delta")
    expect(body).toContain("event: response.completed")
    expect(gateway.active).toBe(0)
  })
  test("unsupported background Responses fail instead of creating inaccessible jobs", async () => {
    const { gateway } = make()
    expect(
      (
        await gateway.handle(
          request("/v1/responses", {
            model: "response-test",
            input: "hi",
            background: true,
          }),
        )
      ).status,
    ).toBe(400)
  })
  test("native count endpoint results are returned exactly", async () => {
    const { gateway, upstream } = make()
    upstream.respond = () => Response.json({ input_tokens: 77 })
    const response = await gateway.handle(
      request("/v1/messages/count_tokens", {
        model: messages.model,
        messages: messages.messages,
      }),
    )
    expect(await response.json()).toEqual({ input_tokens: 77 })
    expect(response.headers.has("x-token-count-estimated")).toBeFalse()
  })
  test("missing native count endpoint falls back to a labelled estimate and is not reprobed", async () => {
    const { gateway, upstream } = make()
    upstream.respond = () => {
      throw new GatewayError(404, "not_found_error", "missing")
    }
    const body = { model: messages.model, messages: messages.messages }
    const response = await gateway.handle(
      request("/v1/messages/count_tokens", body),
    )
    expect(response.headers.get("x-token-count-estimated")).toBe("true")
    expect(
      ((await response.json()) as { input_tokens: number }).input_tokens,
    ).toBeGreaterThan(1)
    await gateway.handle(request("/v1/messages/count_tokens", body))
    expect(
      upstream.calls.filter((call) => call.path.endsWith("count_tokens")),
    ).toHaveLength(1)
  })
  test("embeddings preserve dimensions and encoding", async () => {
    const { gateway, upstream } = make()
    const payload = {
      model: "embed-test",
      input: ["one", "two"],
      dimensions: 32,
      encoding_format: "base64",
    }
    expect(
      (await gateway.handle(request("/v1/embeddings", payload))).status,
    ).toBe(200)
    expect(upstream.calls.at(-1)?.payload).toEqual(payload)
  })
  test("Copilot embeddings gain required OpenAI envelope fields without losing usage", async () => {
    const { gateway, upstream } = make()
    upstream.respond = () =>
      Response.json({
        data: [{ index: 0, object: "embedding", embedding: [0.1, 0.2] }],
        usage: { prompt_tokens: 2, total_tokens: 2 },
        future_field: true,
      })
    const response = await gateway.handle(
      request("/v1/embeddings", { model: "embed-test", input: ["hello"] }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      object: "list",
      model: "embed-test",
      data: [{ index: 0, object: "embedding", embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 2, total_tokens: 2 },
      future_field: true,
    })
  })
})

describe("lifecycle and failures", () => {
  test("malformed upstream successes become 502 for every inference protocol", async () => {
    const { gateway, upstream } = make()
    upstream.respond = () => Response.json({ malformed: true })
    for (const [path, payload] of [
      ["/v1/chat/completions", chat],
      ["/v1/messages", messages],
      ["/v1/responses", { model: "response-test", input: "hi" }],
      ["/v1/embeddings", { model: "embed-test", input: "hi" }],
    ] as const) {
      expect((await gateway.handle(request(path, payload))).status).toBe(502)
    }
  })
  test("upstream errors and recovery hints retain provider wording", async () => {
    const { gateway, upstream, logs } = make()
    const body = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "thinking block bound to a different conversation",
      },
    }
    upstream.respond = () => {
      throw new GatewayError(
        400,
        "invalid_request_error",
        "rejected",
        undefined,
        body,
        new Headers({ "x-should-retry": "false" }),
      )
    }
    const response = await gateway.handle(request("/v1/messages", messages))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(body)
    expect(response.headers.get("x-should-retry")).toBe("false")
    expect(JSON.stringify(logs)).not.toContain(apiKey)
    expect(JSON.stringify(logs)).not.toContain("conversation")
  })
  test("concurrency slots cover the entire stream and release on cancellation", async () => {
    const { gateway, upstream } = make({ MAX_CONCURRENT_REQUESTS: "1" })
    let cancelled = false
    upstream.respond = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    const first = await gateway.handle(
      request("/v1/chat/completions", { ...chat, stream: true }),
    )
    expect(
      (await gateway.handle(request("/v1/chat/completions", chat))).status,
    ).toBe(429)
    await first.body?.cancel()
    expect(gateway.active).toBe(0)
    expect(cancelled).toBeTrue()
    expect(
      (
        await gateway.handle(
          request("/v1/chat/completions", { ...chat, stream: true }),
        )
      ).status,
    ).toBe(200)
    gateway.abort()
  })
  test("request timeout aborts transport and releases admission", async () => {
    const { gateway, upstream } = make({ REQUEST_TIMEOUT_MS: "100" })
    upstream.respond = (_path, _payload, signal) =>
      withSignal(new Promise<Response>(() => {}), signal)
    expect(
      (await gateway.handle(request("/v1/chat/completions", chat))).status,
    ).toBe(504)
    expect(upstream.calls.at(-1)?.signal.aborted).toBeTrue()
    expect(gateway.active).toBe(0)
  })
  test("idle streams time out with a protocol error instead of reporting success", async () => {
    const { gateway, upstream } = make({ REQUEST_TIMEOUT_MS: "100" })
    upstream.respond = () =>
      new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "text/event-stream" },
      })
    const response = await gateway.handle(
      request("/v1/messages", { ...messages, stream: true }),
    )
    expect(await response.text()).toContain("timeout_error")
    expect(gateway.active).toBe(0)
  })
  test("truncated OpenAI streams emit one error and never synthesize DONE", async () => {
    const { gateway, upstream } = make()
    upstream.respond = () => sse([chunk({ content: "partial" })])
    const response = await gateway.handle(
      request("/v1/chat/completions", { ...chat, stream: true }),
    )
    const text = await response.text()
    expect(text).toContain("partial")
    expect(text).toContain("disconnected")
    expect(text).not.toContain("data: [DONE]\n")
    expect(gateway.active).toBe(0)
  })
  test("native stream errors retain original payload and end without message_stop", async () => {
    const { gateway, upstream } = make()
    const error = {
      type: "error",
      error: { type: "overloaded_error", message: "model busy" },
    }
    upstream.respond = () =>
      sse([{ type: "message_start", message: { id: "msg" } }, error])
    const response = await gateway.handle(
      request("/v1/messages", { ...messages, stream: true }),
    )
    const text = await response.text()
    expect(text).toContain(JSON.stringify(error))
    expect(text).not.toContain("message_stop")
    expect(text.split("event: error")).toHaveLength(2)
  })
  test("client abort cancels an in-flight upstream request", async () => {
    const { gateway, upstream } = make()
    const controller = new AbortController()
    upstream.respond = (_path, _payload, signal) => {
      controller.abort()
      return withSignal(new Promise<Response>(() => {}), signal)
    }
    expect(
      (
        await gateway.handle(
          request("/v1/chat/completions", chat, {}, controller.signal),
        )
      ).status,
    ).toBe(499)
    expect(gateway.active).toBe(0)
  })
  test("draining rejects new inference while health remains available", async () => {
    const { gateway } = make()
    gateway.drain()
    expect(
      (await gateway.handle(request("/v1/chat/completions", chat))).status,
    ).toBe(503)
    expect((await gateway.handle(request("/healthz"))).status).toBe(200)
    expect((await gateway.handle(request("/readyz"))).status).toBe(503)
  })
})
