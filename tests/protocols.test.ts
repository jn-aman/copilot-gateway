import { expect, test } from "bun:test"

import { sseData } from "~/io"
import { stopReason, toAnthropic, toOpenAI } from "~/protocols/anthropic"
import { completionSchema, messagesSchema } from "~/protocols/schemas"
import { anthropicStream, openaiStream } from "~/protocols/streams"

import { chunk, sse } from "./helpers"

test("parallel tools with fragmented names and IDs yield valid ordered Anthropic blocks", async () => {
  const response = sse(
    [
      chunk({ content: "Checking…" }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_",
            function: { name: "get_", arguments: '{"a":' },
          },
          {
            index: 1,
            id: "call_2",
            function: { name: "second", arguments: "{" },
          },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 1, function: { arguments: "}" } },
          { index: 0, id: "1", function: { name: "first", arguments: "1}" } },
        ],
      }),
      chunk({}, "tool_calls"),
      {
        ...chunk(),
        choices: [],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 10 },
        },
      },
      "[DONE]",
    ],
    1,
  )
  const events: Array<Record<string, unknown>> = []
  for await (const bytes of anthropicStream(
    response.body!,
    new AbortController().signal,
  )) {
    const text = new TextDecoder().decode(bytes)
    events.push(JSON.parse(text.split("data: ")[1]!) as Record<string, unknown>)
  }
  const starts = events.filter((event) => event.type === "content_block_start")
  expect(starts.map((event) => event.index)).toEqual([0, 1, 2])
  expect(starts[1]?.content_block).toEqual({
    type: "tool_use",
    id: "call_1",
    name: "get_first",
    input: {},
  })
  const open = new Set<unknown>()
  for (const event of events) {
    if (event.type === "content_block_start") {
      expect(open.has(event.index)).toBeFalse()
      open.add(event.index)
    }
    if (event.type === "content_block_delta")
      expect(open.has(event.index)).toBeTrue()
    if (event.type === "content_block_stop") {
      expect(open.has(event.index)).toBeTrue()
      open.delete(event.index)
    }
  }
  expect(open.size).toBe(0)
  expect(events.find((event) => event.type === "message_delta")?.usage).toEqual(
    { input_tokens: 20, output_tokens: 20, cache_read_input_tokens: 10 },
  )
  expect(events.find((event) => event.type === "message_delta")?.delta).toEqual(
    { stop_reason: "tool_use", stop_sequence: null },
  )
  expect(events.at(-1)?.type).toBe("message_stop")
})

test("invalid tool arguments fail without a successful terminal event", async () => {
  const response = sse([
    chunk({
      tool_calls: [
        { index: 0, id: "call", function: { name: "Bash", arguments: "bad" } },
      ],
    }),
    chunk({}, "stop"),
    "[DONE]",
  ])
  const events: string[] = []
  await expect(
    (async () => {
      for await (const bytes of anthropicStream(
        response.body!,
        new AbortController().signal,
      ))
        events.push(new TextDecoder().decode(bytes))
    })(),
  ).rejects.toThrow("invalid tool arguments")
  expect(events.join("")).not.toContain("message_stop")
})

test("fallback translates images and structured tool results without dropping content", () => {
  const payload = messagesSchema.parse({
    model: "chat-test",
    max_tokens: 64,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call",
            name: "read",
            input: { path: "file" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call",
            content: [
              { type: "text", text: "result" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "YWJj",
                },
              },
            ],
          },
          { type: "text", text: "continue" },
        ],
      },
    ],
  })
  const translated = toOpenAI(payload)
  expect(translated.messages).toEqual([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call",
          type: "function",
          function: { name: "read", arguments: '{"path":"file"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call",
      content: [
        { type: "text", text: "result" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
      ],
    },
    { role: "user", content: "continue" },
  ])
})

test("nonstream translation selects choice zero instead of combining alternatives", () => {
  const response = completionSchema.parse({
    id: "chat",
    model: "test",
    choices: [
      {
        index: 1,
        message: { role: "assistant", content: "alternate" },
        finish_reason: "stop",
      },
      {
        index: 0,
        message: {
          role: "assistant",
          content: "chosen",
          tool_calls: [
            {
              id: "call",
              type: "function",
              function: { name: "tool", arguments: "{}" },
            },
          ],
        },
        finish_reason: "stop",
      },
    ],
  })
  expect(toAnthropic(response).content).toEqual([
    { type: "text", text: "chosen" },
    { type: "tool_use", id: "call", name: "tool", input: {} },
  ])
  expect(stopReason("content_filter")).toBe("refusal")
  expect(toAnthropic(response).stop_reason).toBe("tool_use")
})

test("SSE handles split UTF8, CRLF, multiline data and comments", async () => {
  const bytes = new TextEncoder().encode(
    ': comment\r\ndata: {\r\ndata: "hello": "🌍"}\r\n\r\n',
  )
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index))
      else controller.close()
    },
  })
  const events: string[] = []
  for await (const event of sseData(body, new AbortController().signal))
    events.push(event)
  expect(events).toEqual(['{\n"hello": "🌍"}'])
})

test("unfinished SSE events and excessive frames fail explicitly", async () => {
  for (const [text, maximum] of [
    ["data: incomplete", 100],
    ["data: too-large\n\n", 4],
  ] as const) {
    const body = new Response(text).body!
    await expect(
      (async () => {
        for await (const event of sseData(
          body,
          new AbortController().signal,
          maximum,
        ))
          void event
      })(),
    ).rejects.toThrow()
  }
})

test("OpenAI forwards trailing usage before DONE", async () => {
  const response = sse([
    chunk({ content: "hello" }),
    chunk({}, "stop"),
    {
      ...chunk(),
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    },
    "[DONE]",
  ])
  let result = ""
  for await (const bytes of openaiStream(
    response.body!,
    new AbortController().signal,
  ))
    result += new TextDecoder().decode(bytes)
  expect(result.indexOf('"prompt_tokens":4')).toBeLessThan(
    result.indexOf("data: [DONE]"),
  )
})

test("native chat deltas with omitted finish reasons remain unfinished and preserve custom tools", async () => {
  const delta = chunk({
    tool_calls: [
      {
        index: 0,
        id: "custom-1",
        type: "custom",
        custom: { name: "edit", input: "patch" },
      },
    ],
  })
  const { finish_reason: _reason, ...choice } = delta.choices[0]!
  const withoutFinish = { ...delta, choices: [choice] }
  const read = async (events: unknown[]) => {
    let result = ""
    for await (const bytes of openaiStream(
      sse(events).body!,
      new AbortController().signal,
    ))
      result += new TextDecoder().decode(bytes)
    return result
  }
  await expect(read([withoutFinish, "[DONE]"])).rejects.toThrow(
    "without a finish reason",
  )
  const result = await read([withoutFinish, chunk({}, "stop"), "[DONE]"])
  expect(result).toContain('"finish_reason":null')
  expect(result).toContain('"custom":{"name":"edit","input":"patch"}')
  expect(result).toContain('"finish_reason":"tool_calls"')
})

test("every requested native chat choice must complete before DONE", async () => {
  const finished = chunk({}, "stop")
  const read = async (events: unknown[]) => {
    for await (const event of openaiStream(
      sse(events).body!,
      new AbortController().signal,
      2,
    ))
      void event
  }
  await expect(read([finished, "[DONE]"])).rejects.toThrow(
    "without a finish reason",
  )
  await read([
    finished,
    { ...finished, choices: [{ ...finished.choices[0]!, index: 1 }] },
    "[DONE]",
  ])
})
