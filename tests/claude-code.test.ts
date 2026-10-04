import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { claudeEnvironment } from "~/claude"
import { Gateway } from "~/gateway"

import { config, FakeUpstream, sse } from "./helpers"

test.skipIf(!Bun.which("claude"))(
  "installed Claude Code discovers and executes a real MCP tool through the gateway",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-mcp-test-"))
    const upstream = new FakeUpstream()
    let toolDiscovered = false
    let toolReturned = false
    let toolIssued = false
    upstream.respond = (path, payload) => {
      if (path.endsWith("count_tokens"))
        return Response.json({ input_tokens: 100 })
      const tools = payload?.tools as Array<{ name?: string }> | undefined
      if (tools?.some((tool) => tool.name === "mcp__fixture__echo"))
        toolDiscovered = true
      const messages = payload?.messages as
        | Array<{
            content?:
              | string
              | Array<{ type: string; tool_use_id?: string; content?: unknown }>
          }>
        | undefined
      const result = messages
        ?.flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .find(
          (block) =>
            block.type === "tool_result" &&
            block.tool_use_id === "toolu_mcp_fixture",
        )
      if (
        result &&
        JSON.stringify(result.content).includes("MCP_ROUND_TRIP_OK")
      )
        toolReturned = true
      const tool = toolDiscovered && !toolIssued
      if (tool) toolIssued = true
      return sse(
        [
          {
            type: "message_start",
            message: {
              id: `msg_${crypto.randomUUID()}`,
              type: "message",
              role: "assistant",
              model: String(payload?.model),
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: tool
              ? {
                  type: "tool_use",
                  id: "toolu_mcp_fixture",
                  name: "mcp__fixture__echo",
                  input: {},
                }
              : { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: tool
              ? {
                  type: "input_json_delta",
                  partial_json: '{"value":"MCP_ROUND_TRIP_OK"}',
                }
              : { type: "text_delta", text: "MCP_OK" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: {
              stop_reason: tool ? "tool_use" : "end_turn",
              stop_sequence: null,
            },
            usage: { output_tokens: 10 },
          },
          { type: "message_stop" },
        ],
        3,
      )
    }
    const gatewayConfig = config()
    const gateway = new Gateway(gatewayConfig, upstream, () => {})
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => gateway.handle(request),
    })
    const env = claudeEnvironment(
      { ...gatewayConfig, PORT: server.port! },
      { primary: "claude-sonnet-4.6", fast: "claude-haiku-4.5" },
    )
    env.CLAUDE_CONFIG_DIR = join(directory, ".claude")
    env.ENABLE_TOOL_SEARCH = "false"
    const mcpConfig = join(directory, "mcp.json")
    await writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [join(import.meta.dir, "fixtures", "mcp-server.ts")],
          },
        },
      }),
    )
    const child = Bun.spawn(
      [
        Bun.which("claude")!,
        "--print",
        "Use the fixture echo tool to echo MCP_ROUND_TRIP_OK, then reply MCP_OK.",
        "--mcp-config",
        mcpConfig,
        "--strict-mcp-config",
        "--allowedTools",
        "mcp__fixture__echo",
        "--max-turns",
        "3",
      ],
      { cwd: directory, env, stdout: "pipe", stderr: "pipe" },
    )
    const timeout = setTimeout(() => child.kill(), 30000)
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ exit, stderr }).toMatchObject({ exit: 0 })
      expect(stdout).toContain("MCP_OK")
      expect(toolDiscovered).toBeTrue()
      expect(toolReturned).toBeTrue()
    } finally {
      clearTimeout(timeout)
      child.kill()
      gateway.abort()
      await server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
  35000,
)

// Uses a local upstream fixture and an isolated Claude config/work directory.
// No GitHub/Anthropic credentials or live inference are used.
test.skipIf(!Bun.which("claude"))(
  "installed Claude Code completes a native streamed Bash tool round trip",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-claude-test-"))
    const upstream = new FakeUpstream()
    let toolIssued = false
    let toolReturned = false
    upstream.respond = (path, payload) => {
      if (path.endsWith("count_tokens"))
        return Response.json({ input_tokens: 100 })
      const messages = payload?.messages as
        | Array<{
            role: string
            content:
              | Array<{ type: string; tool_use_id?: string; content?: unknown }>
              | string
          }>
        | undefined
      const result = messages?.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              block.type === "tool_result" &&
              block.tool_use_id === "toolu_fixture",
          ),
      )
      if (result) toolReturned = true
      const tool =
        !toolIssued &&
        Array.isArray(payload?.tools) &&
        payload.tools.some(
          (item: unknown) =>
            typeof item === "object" &&
            item !== null &&
            "name" in item &&
            item.name === "Bash",
        )
      if (tool) toolIssued = true
      const contentBlock = tool
        ? { type: "tool_use", id: "toolu_fixture", name: "Bash", input: {} }
        : { type: "text", text: "" }
      const delta = tool
        ? {
            type: "input_json_delta",
            partial_json:
              '{"command":"pwd","description":"Print working directory"}',
          }
        : { type: "text_delta", text: "MOCK_OK" }
      return sse(
        [
          {
            type: "message_start",
            message: {
              id: `msg_${crypto.randomUUID()}`,
              type: "message",
              role: "assistant",
              model: String(payload?.model),
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: 100,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: contentBlock,
          },
          { type: "content_block_delta", index: 0, delta },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: {
              stop_reason: tool ? "tool_use" : "end_turn",
              stop_sequence: null,
            },
            usage: { output_tokens: 10 },
          },
          { type: "message_stop" },
        ],
        13,
      )
    }
    const gatewayConfig = config()
    const gateway = new Gateway(gatewayConfig, upstream, () => {})
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => gateway.handle(request),
    })
    const env = claudeEnvironment(
      { ...gatewayConfig, PORT: server.port! },
      { primary: "claude-sonnet-4.6", fast: "claude-haiku-4.5" },
    )
    env.CLAUDE_CONFIG_DIR = join(directory, ".claude")
    const child = Bun.spawn(
      [
        Bun.which("claude")!,
        "--print",
        "Run pwd using Bash, then reply MOCK_OK.",
        "--allowedTools",
        "Bash(pwd)",
        "--max-turns",
        "3",
      ],
      { cwd: directory, env, stdout: "pipe", stderr: "pipe" },
    )
    const timeout = setTimeout(() => child.kill(), 30000)
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ exit, stderr }).toMatchObject({ exit: 0 })
      expect(stdout).toContain("MOCK_OK")
      expect(toolIssued).toBeTrue()
      expect(toolReturned).toBeTrue()
    } finally {
      clearTimeout(timeout)
      child.kill()
      gateway.abort()
      await server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
  35000,
)
