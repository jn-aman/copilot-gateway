import type { RuntimeConfig } from "~/config"
import type { Chunk, Usage } from "~/protocols/schemas"

import { GatewayError } from "~/errors"
import { encodeEvent, sseData } from "~/io"
import { stopReason, toolInput, usage } from "~/protocols/anthropic"
import { chunkSchema, nativeChunkSchema } from "~/protocols/schemas"

function parseObject(data: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("Invalid object")
    return parsed as Record<string, unknown>
  } catch {
    throw new GatewayError(
      502,
      "api_error",
      "Copilot returned an invalid stream event",
    )
  }
}

export async function* openaiStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  expectedChoices = 1,
  maxEventBytes = 1048576,
): AsyncGenerator<Uint8Array> {
  const finished = new Set<number>()
  const toolChoices = new Set<number>()
  for await (const data of sseData(body, signal, maxEventBytes)) {
    if (data === "[DONE]") {
      if (finished.size !== expectedChoices)
        throw new GatewayError(
          502,
          "api_error",
          "Copilot stream ended without a finish reason",
        )
      yield encodeEvent(data)
      return
    }
    const object = parseObject(data)
    if (object.error)
      throw new GatewayError(
        502,
        "api_error",
        "Copilot reported a stream error",
        undefined,
        object,
      )
    const chunk = nativeChunkSchema.safeParse(object)
    if (!chunk.success)
      throw new GatewayError(
        502,
        "api_error",
        "Copilot returned an invalid completion chunk",
      )
    for (const choice of chunk.data.choices) {
      if (choice.index >= expectedChoices)
        throw new GatewayError(
          502,
          "api_error",
          "Copilot returned an unexpected choice index",
        )
      if (choice.finish_reason !== null) finished.add(choice.index)
      if (
        Array.isArray(choice.delta.tool_calls) &&
        choice.delta.tool_calls.length
      )
        toolChoices.add(choice.index)
      // Copilot sometimes ends a tool call with "stop". OpenAI clients need
      // "tool_calls" to distinguish a completed call from a final answer.
      if (choice.finish_reason === "stop" && toolChoices.has(choice.index))
        choice.finish_reason = "tool_calls"
    }
    // Copilot omits finish_reason on ordinary deltas. OpenAI's wire format
    // defines it as null until completion. All other native fields survive.
    yield encodeEvent(chunk.data)
  }
  throw new GatewayError(
    502,
    "api_error",
    "Copilot stream disconnected before [DONE]",
  )
}

export async function* nativeStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  protocol: "messages" | "responses",
  maxEventBytes = 1048576,
): AsyncGenerator<Uint8Array> {
  for await (const data of sseData(body, signal, maxEventBytes)) {
    if (data === "[DONE]")
      throw new GatewayError(
        502,
        "api_error",
        "Copilot stream is missing its terminal event",
      )
    const event = parseObject(data)
    if (typeof event.type !== "string")
      throw new GatewayError(
        502,
        "api_error",
        "Copilot stream event has no type",
      )
    if (event.type === "error" || event.type === "response.failed")
      throw new GatewayError(
        502,
        "api_error",
        "Copilot reported a stream error",
        undefined,
        event,
      )
    yield encodeEvent(event, event.type)
    if (
      protocol === "messages"
        ? event.type === "message_stop"
        : ["response.completed", "response.incomplete"].includes(event.type)
    )
      return
  }
  throw new GatewayError(
    502,
    "api_error",
    "Copilot stream disconnected before completion",
  )
}

// Text is delivered immediately. Parallel tool fragments are accumulated by
// upstream index, then emitted as complete ordered blocks. This avoids sending
// fragments to a closed Anthropic block when Copilot interleaves calls.
export async function* anthropicStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  limits: Pick<
    RuntimeConfig,
    "MAX_SSE_EVENT_BYTES" | "MAX_TOOL_BUFFER_BYTES" | "MAX_PARALLEL_TOOLS"
  > = {
    MAX_SSE_EVENT_BYTES: 1048576,
    MAX_TOOL_BUFFER_BYTES: 4194304,
    MAX_PARALLEL_TOOLS: 128,
  },
): AsyncGenerator<Uint8Array> {
  let started = false
  let textOpen = false
  let blockIndex = 0
  let finish: string | null = null
  let finalUsage: Usage | null | undefined
  let toolBytes = 0
  const tools = new Map<
    number,
    { id: string; name: string; arguments: string }
  >()
  const event = (data: { type: string; [key: string]: unknown }) =>
    encodeEvent(data, data.type)
  let ended = false
  for await (const data of sseData(body, signal, limits.MAX_SSE_EVENT_BYTES)) {
    if (data === "[DONE]") {
      ended = true
      break
    }
    const parsed = chunkSchema.safeParse(parseObject(data))
    if (!parsed.success)
      throw new GatewayError(
        502,
        "api_error",
        "Copilot returned an invalid completion chunk",
      )
    const chunk: Chunk = parsed.data
    if (chunk.usage) finalUsage = chunk.usage
    const choice = chunk.choices.find((choice) => choice.index === 0)
    if (!choice) continue
    if (!started) {
      yield event({
        type: "message_start",
        message: {
          id: chunk.id,
          type: "message",
          role: "assistant",
          model: chunk.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...usage(chunk.usage), output_tokens: 0 },
        },
      })
      started = true
    }
    if (choice.delta.content) {
      if (!textOpen) {
        yield event({
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        })
        textOpen = true
      }
      yield event({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "text_delta", text: choice.delta.content },
      })
    }
    for (const delta of choice.delta.tool_calls ?? []) {
      const tool = tools.get(delta.index) ?? { id: "", name: "", arguments: "" }
      tool.id += delta.id ?? ""
      tool.name += delta.function?.name ?? ""
      tool.arguments += delta.function?.arguments ?? ""
      toolBytes +=
        Buffer.byteLength(delta.id ?? "", "utf8") +
        Buffer.byteLength(delta.function?.name ?? "", "utf8") +
        Buffer.byteLength(delta.function?.arguments ?? "", "utf8")
      if (
        toolBytes > limits.MAX_TOOL_BUFFER_BYTES ||
        (!tools.has(delta.index) && tools.size >= limits.MAX_PARALLEL_TOOLS)
      )
        throw new GatewayError(
          502,
          "api_error",
          "Copilot tool stream exceeded size limit",
        )
      tools.set(delta.index, tool)
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }
  if (!ended || !finish || !started)
    throw new GatewayError(
      502,
      "api_error",
      "Copilot stream disconnected before completion",
    )
  if (textOpen) {
    yield event({ type: "content_block_stop", index: blockIndex })
    blockIndex++
  }
  for (const [, tool] of [...tools].sort(([a], [b]) => a - b)) {
    if (!tool.id || !tool.name)
      throw new GatewayError(502, "api_error", "Incomplete Copilot tool call")
    toolInput(tool.arguments)
    yield event({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: tool.id,
        name: tool.name,
        input: {},
      },
    })
    yield event({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: tool.arguments || "{}" },
    })
    yield event({ type: "content_block_stop", index: blockIndex++ })
  }
  yield event({
    type: "message_delta",
    delta: {
      stop_reason: stopReason(finish, tools.size > 0),
      stop_sequence: null,
    },
    usage: usage(finalUsage),
  })
  yield event({ type: "message_stop" })
}
