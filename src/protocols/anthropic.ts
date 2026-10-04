import { z } from "zod"

import type { Completion, MessagesPayload, Usage } from "~/protocols/schemas"

import { GatewayError } from "~/errors"

type Message = {
  role: string
  content: unknown
  tool_call_id?: string
  tool_calls?: unknown[]
}
type Content = Extract<
  MessagesPayload["messages"][number]["content"],
  unknown[]
>[number]

function contentParts(blocks: Content[]): unknown {
  const parts = blocks.flatMap<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >((block) => {
    if (block.type === "text") return [{ type: "text", text: block.text }]
    if (block.type === "image")
      return [
        {
          type: "image_url",
          image_url: {
            url:
              block.source.type === "url"
                ? block.source.url
                : `data:${block.source.media_type};base64,${block.source.data}`,
          },
        },
      ]
    return []
  })
  return parts.every((part) => part.type === "text")
    ? parts.map((part) => ("text" in part ? part.text : "")).join("\n\n")
    : parts
}

export function toOpenAI(payload: MessagesPayload): Record<string, unknown> {
  const messages: Message[] = []
  if (payload.system)
    messages.push({
      role: "system",
      content:
        typeof payload.system === "string"
          ? payload.system
          : payload.system.map((block) => block.text).join("\n\n"),
    })
  for (const message of payload.messages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content })
      continue
    }
    if (message.role === "user") {
      for (const block of message.content) {
        if (block.type === "tool_result")
          messages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content:
              typeof block.content === "string"
                ? block.content
                : contentParts(block.content ?? []),
          })
      }
      const blocks = message.content.filter(
        (block) => block.type !== "tool_result",
      )
      if (blocks.length)
        messages.push({ role: "user", content: contentParts(blocks) })
    } else {
      const calls = message.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        }))
      messages.push({
        role: "assistant",
        content: contentParts(message.content) || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      })
    }
  }
  const choice = payload.tool_choice
  return {
    model: payload.model,
    messages,
    max_tokens: payload.max_tokens,
    stream: payload.stream,
    ...(payload.stream ? { stream_options: { include_usage: true } } : {}),
    temperature: payload.temperature,
    top_p: payload.top_p,
    stop: payload.stop_sequences,
    user: payload.metadata?.user_id,
    tools: payload.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    })),
    tool_choice:
      choice?.type === "tool"
        ? { type: "function", function: { name: choice.name } }
        : choice?.type === "any"
          ? "required"
          : choice?.type,
    ...(choice && "disable_parallel_tool_use" in choice
      ? { parallel_tool_calls: !choice.disable_parallel_tool_use }
      : {}),
  }
}

export function stopReason(
  reason: string | null,
  hasTools = false,
): string | null {
  if (reason === "stop" && hasTools) return "tool_use"
  switch (reason) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool_calls":
    case "function_call":
      return "tool_use"
    case "content_filter":
      return "refusal"
    default:
      return null
  }
}

export function usage(usage?: Usage | null) {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0
  return {
    input_tokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
    output_tokens: usage?.completion_tokens ?? 0,
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  }
}

export function toolInput(argumentsJson: string): Record<string, unknown> {
  try {
    return z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(argumentsJson || "{}"))
  } catch {
    throw new GatewayError(
      502,
      "api_error",
      "Copilot returned invalid tool arguments",
    )
  }
}

export function toAnthropic(response: Completion) {
  const choice = response.choices.find((choice) => choice.index === 0)
  if (!choice)
    throw new GatewayError(
      502,
      "api_error",
      "Copilot response is missing choice zero",
    )
  const content: unknown[] = []
  if (choice.message.content)
    content.push({ type: "text", text: choice.message.content })
  for (const tool of choice.message.tool_calls ?? [])
    content.push({
      type: "tool_use",
      id: tool.id,
      name: tool.function.name,
      input: toolInput(tool.function.arguments),
    })
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content,
    stop_reason: stopReason(
      choice.finish_reason,
      Boolean(choice.message.tool_calls?.length),
    ),
    stop_sequence: null,
    usage: usage(response.usage),
  }
}
