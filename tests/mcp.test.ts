import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import OpenAI from "openai"
import { expect, test } from "bun:test"
import { join } from "node:path"

import { Gateway } from "~/gateway"

import { apiKey, config, FakeUpstream } from "./helpers"

test("an OpenAI client discovers and executes a real MCP tool through Chat Completions", async () => {
  const mcp = new Client({ name: "gateway-openai-test", version: "1.0.0" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "fixtures", "mcp-server.ts")],
  })
  const upstream = new FakeUpstream()
  let returned = false
  upstream.respond = (_path, payload) => {
    const messages = payload?.messages as Array<{
      role?: string
      content?: string
    }>
    returned = messages.some(
      (message) =>
        message.role === "tool" &&
        message.content?.includes("MCP_ROUND_TRIP_OK"),
    )
    return Response.json({
      id: "chat-mcp",
      model: "chat-test",
      object: "chat.completion",
      created: 1,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: returned
            ? { role: "assistant", content: "MCP_OK" }
            : {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-mcp",
                    type: "function",
                    function: {
                      name: "echo",
                      arguments: '{"value":"MCP_ROUND_TRIP_OK"}',
                    },
                  },
                ],
              },
        },
      ],
    })
  }
  const gateway = new Gateway(config(), upstream, () => {})
  const openai = new OpenAI({
    apiKey,
    baseURL: "http://localhost/v1",
    maxRetries: 0,
    fetch: async (input, init) => gateway.handle(new Request(input, init)),
  })
  try {
    await mcp.connect(transport)
    const discovered = await mcp.listTools()
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] =
      discovered.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }))
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "user", content: "Call echo" },
    ]
    const first = await openai.chat.completions.create({
      model: "chat-test",
      messages,
      tools,
    })
    const message = first.choices[0]!.message
    const call = message.tool_calls?.[0]
    if (!call || call.type !== "function")
      throw new Error("No MCP function call")
    expect(first.choices[0]?.finish_reason).toBe("tool_calls")
    const result = await mcp.callTool({
      name: call.function.name,
      arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
    })
    messages.push(message, {
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(result),
    })
    const second = await openai.chat.completions.create({
      model: "chat-test",
      messages,
      tools,
    })
    expect(returned).toBeTrue()
    expect(second.choices[0]?.message.content).toBe("MCP_OK")
    expect(
      upstream.calls.find((entry) => entry.path === "/chat/completions")
        ?.payload?.tools,
    ).toEqual(tools)
  } finally {
    gateway.abort()
    await mcp.close()
    await transport.close()
  }
})
