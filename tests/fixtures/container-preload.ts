// Test-only transport injected with Bun --preload. It is never part of the image.
import { modelCatalog, chunk, sse } from "../helpers"

const attempts = new Set<string>()
const mockedFetch: typeof fetch = Object.assign(
  async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === "github.com") {
      if (url.pathname === "/login/device/code")
        return Response.json({
          device_code: "fixture-device",
          user_code: "TEST-ONLY",
          verification_uri: "https://github.com/login/device",
          expires_in: 60,
          interval: 0.01,
        })
      if (url.pathname === "/login/oauth/access_token")
        return Response.json({ access_token: "fixture-oauth-credential" })
    }
    if (url.hostname === "api.github.com") {
      if (url.pathname === "/copilot_internal/v2/token")
        return Response.json({
          token: "fixture-copilot-credential",
          expires_at: Date.now() / 1000 + 3600,
          refresh_in: 1800,
          endpoints: { api: "https://api.githubcopilot.com" },
        })
      if (url.pathname === "/copilot_internal/user")
        return Response.json({ quota_snapshots: {} })
    }
    if (url.hostname !== "api.githubcopilot.com")
      throw new Error("Unexpected fixture origin")
    if (url.pathname === "/models") return Response.json(modelCatalog)
    const payload = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >
    const requestId =
      new Headers(init?.headers).get("x-request-id") ?? "fixture"
    if (payload.fixture_rate_limit && !attempts.has(requestId)) {
      attempts.add(requestId)
      return Response.json(
        { error: { message: "fixture rate limit" } },
        { status: 429, headers: { "retry-after": "0" } },
      )
    }
    attempts.delete(requestId)
    if (url.pathname.endsWith("count_tokens"))
      return Response.json({ input_tokens: 100 })
    if (url.pathname === "/embeddings")
      return Response.json({
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      })
    if (url.pathname === "/responses") {
      const response = {
        id: "resp_fixture",
        object: "response",
        status: "completed",
        output: [],
      }
      return payload.stream
        ? sse([
            {
              type: "response.created",
              response: { ...response, status: "in_progress" },
              sequence_number: 0,
            },
            {
              type: "response.output_text.delta",
              delta: "OK",
              sequence_number: 1,
            },
            { type: "response.completed", response, sequence_number: 2 },
          ])
        : Response.json(response)
    }
    const messages = payload.messages as Array<{
      role: string
      content?: unknown
    }>
    const hasResult = messages.some(
      (message) =>
        message.role === "tool" ||
        (Array.isArray(message.content) &&
          message.content.some(
            (block: { type?: string }) => block.type === "tool_result",
          )),
    )
    const tools = payload.tools as
      Array<{ name?: string; function?: { name: string } }> | undefined
    const tool = tools?.[0]
    const useTool = tool && !hasResult
    const toolName = tool?.name ?? tool?.function?.name ?? "echo"
    if (url.pathname === "/v1/messages") {
      const message = {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: payload.model,
        content: useTool
          ? [
              {
                type: "tool_use",
                id: "toolu_fixture",
                name: toolName,
                input: { value: "HTTP_MCP_OK" },
              },
            ]
          : [{ type: "text", text: hasResult ? "HTTP_MCP_OK" : "OK" }],
        stop_reason: useTool ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }
      if (!payload.stream) return Response.json(message)
      return sse([
        {
          type: "message_start",
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: useTool
            ? {
                type: "tool_use",
                id: "toolu_fixture",
                name: toolName,
                input: {},
              }
            : { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: useTool
            ? {
                type: "input_json_delta",
                partial_json: '{"value":"HTTP_MCP_OK"}',
              }
            : { type: "text_delta", text: hasResult ? "HTTP_MCP_OK" : "OK" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ])
    }
    if (url.pathname === "/chat/completions") {
      const toolCall = {
        id: "call_fixture",
        type: "function",
        function: { name: toolName, arguments: '{"value":"HTTP_MCP_OK"}' },
      }
      if (!payload.stream)
        return Response.json({
          id: "chat_fixture",
          object: "chat.completion",
          model: payload.model,
          created: 1,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: useTool
                ? { role: "assistant", content: null, tool_calls: [toolCall] }
                : {
                    role: "assistant",
                    content: hasResult ? "HTTP_MCP_OK" : "OK",
                  },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      const first = chunk(
        useTool
          ? { tool_calls: [{ index: 0, ...toolCall }] }
          : { content: hasResult ? "HTTP_MCP_OK" : "OK" },
      )
      const { finish_reason: _reason, ...choice } = first.choices[0]!
      return sse([
        { ...first, choices: [choice] },
        chunk({}, "stop"),
        {
          ...chunk(),
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        "[DONE]",
      ])
    }
    return Response.json(
      { error: { message: "Unknown fixture endpoint" } },
      { status: 404 },
    )
  },
  { preconnect() {} },
)
globalThis.fetch = mockedFetch
