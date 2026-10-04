import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { expect, test } from "bun:test"

import { Gateway } from "~/gateway"

import { apiKey, chunk, config, FakeUpstream, sse } from "./helpers"

test("latest OpenAI SDK reads chat streaming, usage and model discovery", async () => {
  const upstream = new FakeUpstream()
  upstream.respond = () =>
    sse([
      chunk({ role: "assistant", content: "Hello" }),
      chunk({}, "stop"),
      {
        ...chunk(),
        choices: [],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
      "[DONE]",
    ])
  const gateway = new Gateway(config(), upstream, () => {})
  const client = new OpenAI({
    apiKey,
    baseURL: "http://localhost/v1",
    maxRetries: 0,
    fetch: async (input, init) => gateway.handle(new Request(input, init)),
  })
  const models = await client.models.list()
  expect(models.data.some((model) => model.id === "chat-test")).toBeTrue()
  const stream = await client.chat.completions.create({
    model: "chat-test",
    messages: [{ role: "user", content: "Hi" }],
    stream: true,
    stream_options: { include_usage: true },
  })
  let text = ""
  let tokens = 0
  for await (const event of stream) {
    text += event.choices[0]?.delta.content ?? ""
    if (event.usage) tokens = event.usage.total_tokens
  }
  expect(text).toBe("Hello")
  expect(tokens).toBe(3)
  expect(gateway.active).toBe(0)
})

test("latest Anthropic SDK reconstructs a tool call from native stream fragments", async () => {
  const upstream = new FakeUpstream()
  upstream.respond = () =>
    sse(
      [
        {
          type: "message_start",
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4.6",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 20, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_test",
            name: "Bash",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":' },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"pwd"}' },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 7 },
        },
        { type: "message_stop" },
      ],
      1,
    )
  const gateway = new Gateway(config(), upstream, () => {})
  const client = new Anthropic({
    apiKey,
    baseURL: "http://localhost",
    maxRetries: 0,
    fetch: async (input, init) => gateway.handle(new Request(input, init)),
  })
  const stream = client.messages.stream({
    model: "claude-sonnet-4.6",
    max_tokens: 64,
    messages: [{ role: "user", content: "Run pwd" }],
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
  })
  const message = await stream.finalMessage()
  expect(message.content).toHaveLength(1)
  expect(message.content[0]).toMatchObject({
    type: "tool_use",
    id: "toolu_test",
    name: "Bash",
    input: { command: "pwd" },
  })
  expect(message.stop_reason).toBe("tool_use")
  expect(message.usage.output_tokens).toBe(7)
  expect(gateway.active).toBe(0)
})

test("latest OpenAI SDK consumes native Responses events", async () => {
  const upstream = new FakeUpstream()
  upstream.respond = () =>
    sse([
      {
        type: "response.created",
        sequence_number: 0,
        response: {
          id: "resp_test",
          object: "response",
          status: "in_progress",
          output: [],
        },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "msg_test",
        output_index: 0,
        content_index: 0,
        delta: "Hello",
      },
      {
        type: "response.completed",
        sequence_number: 2,
        response: {
          id: "resp_test",
          object: "response",
          status: "completed",
          output: [],
        },
      },
    ])
  const gateway = new Gateway(config(), upstream, () => {})
  const client = new OpenAI({
    apiKey,
    baseURL: "http://localhost/v1",
    maxRetries: 0,
    fetch: async (input, init) => gateway.handle(new Request(input, init)),
  })
  const stream = await client.responses.create({
    model: "response-test",
    input: "Hi",
    stream: true,
  })
  const events: string[] = []
  for await (const event of stream) events.push(event.type)
  expect(events).toEqual([
    "response.created",
    "response.output_text.delta",
    "response.completed",
  ])
})

test("latest OpenAI SDK custom Chat tools, structured output and returned tool input pass through", async () => {
  const upstream = new FakeUpstream()
  upstream.respond = () =>
    Response.json({
      id: "chat-custom",
      model: "chat-test",
      object: "chat.completion",
      created: 1,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "custom-1",
                type: "custom",
                custom: { name: "edit", input: "patch" },
              },
            ],
            reasoning: "provider-specific reasoning",
          },
        },
      ],
    })
  const gateway = new Gateway(config(), upstream, () => {})
  const client = new OpenAI({
    apiKey,
    baseURL: "http://localhost/v1",
    maxRetries: 0,
    fetch: async (input, init) => gateway.handle(new Request(input, init)),
  })
  const result = await client.chat.completions.create({
    model: "chat-test",
    messages: [{ role: "user", content: "Edit" }],
    tools: [
      { type: "custom", custom: { name: "edit", format: { type: "text" } } },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "result", strict: true, schema: { type: "object" } },
    },
  })
  expect(result.choices[0]?.message.tool_calls?.[0]).toEqual({
    id: "custom-1",
    type: "custom",
    custom: { name: "edit", input: "patch" },
  })
  expect(result.choices[0]?.finish_reason).toBe("tool_calls")
  expect(upstream.calls.at(-1)?.payload?.tools).toEqual([
    { type: "custom", custom: { name: "edit", format: { type: "text" } } },
  ])
  expect(upstream.calls.at(-1)?.payload?.response_format).toEqual({
    type: "json_schema",
    json_schema: { name: "result", strict: true, schema: { type: "object" } },
  })
})
