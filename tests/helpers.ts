import type { Config } from "~/config"
import type { Upstream } from "~/upstream"

import { loadConfig } from "~/config"

export const apiKey = "test-gateway-key-with-enough-entropy"
export const config = (overrides: Record<string, string> = {}): Config =>
  loadConfig({
    GATEWAY_API_KEY: apiKey,
    MIN_REQUEST_INTERVAL_MS: "0",
    ...overrides,
  })
export const modelCatalog = {
  object: "list",
  data: [
    {
      id: "chat-test",
      supported_endpoints: ["/chat/completions"],
      capabilities: {
        type: "chat",
        limits: { max_output_tokens: 4096 },
        supports: { streaming: true, tool_calls: true },
      },
    },
    {
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet",
      supported_endpoints: ["/v1/messages", "/chat/completions"],
      capabilities: { supports: { streaming: true, tool_calls: true } },
    },
    { id: "claude-haiku-4.5", supported_endpoints: ["/v1/messages"] },
    { id: "response-test", supported_endpoints: ["/responses"] },
    {
      id: "embed-test",
      supported_endpoints: ["/embeddings"],
      capabilities: { type: "embeddings" },
    },
    {
      id: "disabled",
      policy: { state: "disabled" },
      supported_endpoints: ["/chat/completions"],
    },
    {
      id: "no-tools",
      supported_endpoints: ["/chat/completions"],
      capabilities: {
        supports: { tool_calls: false, streaming: false, vision: false },
      },
    },
  ],
}

export function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
}

export class FakeUpstream implements Upstream {
  ready = true
  calls: Array<{
    path: string
    payload?: Record<string, unknown>
    headers?: Record<string, string>
    signal: AbortSignal
  }> = []
  respond: (
    path: string,
    payload: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ) => Response | Promise<Response> = (path, payload) =>
    Response.json(
      path === "/v1/messages"
        ? {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: payload?.model,
            content: [{ type: "text", text: "hello" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        : path === "/responses"
          ? {
              id: "resp_fixture",
              object: "response",
              status: "completed",
              output: [],
            }
          : path === "/embeddings"
            ? {
                object: "list",
                model: payload?.model,
                data: [{ object: "embedding", index: 0, embedding: [0.1] }],
                usage: { prompt_tokens: 1, total_tokens: 1 },
              }
            : {
                id: "chat_fixture",
                model: payload?.model,
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "hello" },
                    finish_reason: "stop",
                  },
                ],
              },
    )
  async request(
    path: string,
    payload: Record<string, unknown> | undefined,
    signal: AbortSignal,
    _requestId: string,
    headers?: Record<string, string>,
  ): Promise<Response> {
    this.calls.push({ path, payload, signal, headers })
    if (path === "/models") return Response.json(modelCatalog)
    return this.respond(path, payload, signal)
  }
  async usage() {
    return { quota_snapshots: {} }
  }
}

export function sse(events: Array<unknown | string>, byteSize = 7): Response {
  const bytes = new TextEncoder().encode(
    events
      .map(
        (event) =>
          `data: ${typeof event === "string" ? event : JSON.stringify(event)}\r\n\r\n`,
      )
      .join(""),
  )
  let offset = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close()
          return
        }
        controller.enqueue(bytes.slice(offset, offset + byteSize))
        offset += byteSize
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

export function chunk(
  delta: Record<string, unknown> = {},
  finish: string | null = null,
  usage?: Record<string, unknown>,
) {
  return {
    id: "chat-123",
    object: "chat.completion.chunk",
    created: 1,
    model: "chat-test",
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    ...(usage ? { usage } : {}),
  }
}
