import Anthropic from "@anthropic-ai/sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import OpenAI from "openai"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const image = process.env.TEST_IMAGE ?? "copilot-gateway:test"
const key = "container-fixture-client-key"
const directory = await mkdtemp(join(tmpdir(), "copilot-container-test-"))
let container: string | undefined
let volume: string | undefined
const docker = async (...args: string[]) => {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== 0) throw new Error(`Docker failed: ${stderr.trim()}`)
  return stdout.trim()
}
try {
  const preload = join(directory, "preload.js")
  const built = await Bun.build({
    entrypoints: ["tests/fixtures/container-preload.ts"],
    target: "bun",
    outdir: directory,
    naming: "preload.js",
  })
  assert(built.success, "Fixture preload build failed")
  volume = await docker(
    "volume",
    "create",
    `copilot-test-${crypto.randomUUID()}`,
  )
  const login = await docker(
    "run",
    "--rm",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--mount",
    `type=volume,source=${volume},target=/data`,
    "--mount",
    `type=bind,source=${preload},target=/fixture.js,readonly`,
    image,
    "bun",
    "--preload",
    "/fixture.js",
    "dist/main.js",
    "auth",
  )
  assert(
    login.includes("TEST-ONLY") &&
      login.includes("GitHub credential saved privately."),
    "Headless login did not persist a credential",
  )
  container = await docker(
    "run",
    "--detach",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--tmpfs",
    "/tmp",
    "--publish",
    "127.0.0.1::4141",
    "--env",
    `GATEWAY_API_KEY=${key}`,
    "--mount",
    `type=volume,source=${volume},target=/data,readonly`,
    "--env",
    "REQUEST_TIMEOUT_MS=1000",
    "--mount",
    `type=bind,source=${preload},target=/fixture.js,readonly`,
    image,
    "bun",
    "--preload",
    "/fixture.js",
    "dist/main.js",
    "start",
  )
  const address = await docker("port", container, "4141/tcp")
  const base = `http://${address}`
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  }
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(`${base}/healthz`)).ok
    } catch {}
    if (ready) break
    await Bun.sleep(100)
  }
  assert(ready, "Container did not become healthy")
  const get = (path: string) => fetch(base + path, { headers })
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) })
  assert.equal((await fetch(base + "/v1/models")).status, 401)
  assert.equal((await get("/readyz")).status, 200)
  assert.equal((await get("/usage")).status, 200)
  assert.equal(
    (await fetch(base + "/api/hello", { method: "HEAD", headers })).status,
    200,
  )
  assert.equal((await get("/token")).status, 404)
  assert.equal(
    (
      await post("/v1/responses", {
        model: "response-test",
        input: "hi",
        background: true,
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await post("/v1/chat/completions", {
        model: "disabled",
        messages: [{ role: "user", content: "hi" }],
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await post("/v1/chat/completions", {
        model: "response-test",
        messages: [{ role: "user", content: "hi" }],
      })
    ).status,
    400,
  )
  const openai = new OpenAI({
    apiKey: key,
    baseURL: base + "/v1",
    maxRetries: 0,
  })
  const anthropic = new Anthropic({ apiKey: key, baseURL: base, maxRetries: 0 })
  const models = await openai.models.list()
  assert(models.data.some((model) => model.id === "chat-test"))
  assert(!models.data.some((model) => model.id === "disabled"))
  assert.equal(
    (
      await post("/chat/completions", {
        model: "chat-test",
        messages: [{ role: "user", content: "hi" }],
        fixture_rate_limit: true,
      })
    ).status,
    200,
  )
  const chat = await openai.chat.completions.create({
    model: "chat-test",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    stream_options: { include_usage: true },
  })
  let text = ""
  let usage = 0
  for await (const event of chat) {
    text += event.choices[0]?.delta.content ?? ""
    usage = event.usage?.total_tokens ?? usage
  }
  assert.equal(text, "OK")
  assert.equal(usage, 15)
  const mcp = new Client({ name: "container-check", version: "1.0.0" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "..", "tests", "fixtures", "mcp-server.ts")],
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
    const prompt: OpenAI.Chat.Completions.ChatCompletionUserMessageParam = {
      role: "user",
      content: "Call echo",
    }
    const first = await openai.chat.completions.create({
      model: "chat-test",
      messages: [prompt],
      tools,
    })
    const message = first.choices[0]!.message
    const call = message.tool_calls?.[0]
    assert(call?.type === "function")
    assert.equal(first.choices[0]?.finish_reason, "tool_calls")
    const result = await mcp.callTool({
      name: call.function.name,
      arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
    })
    const final = await openai.chat.completions.create({
      model: "chat-test",
      messages: [
        prompt,
        message,
        {
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        },
      ],
      tools,
    })
    assert.equal(final.choices[0]?.message.content, "HTTP_MCP_OK")
  } finally {
    await mcp.close()
    await transport.close()
  }
  const prompt: Anthropic.MessageParam = { role: "user", content: "Call echo" }
  const tools: Anthropic.Tool[] = [
    {
      name: "echo",
      input_schema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
  ]
  const first = await anthropic.messages
    .stream({
      model: "claude-sonnet-4.6",
      max_tokens: 64,
      messages: [prompt],
      tools,
    })
    .finalMessage()
  const call = first.content[0]
  assert(call?.type === "tool_use")
  const final = await anthropic.messages
    .stream({
      model: "claude-sonnet-4.6",
      max_tokens: 64,
      messages: [
        prompt,
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: call.id,
              content: "HTTP_MCP_OK",
            },
          ],
        },
      ],
      tools,
    })
    .finalMessage()
  assert.deepEqual(final.content, [{ type: "text", text: "HTTP_MCP_OK" }])
  const fallback = await anthropic.messages.create({
    model: "chat-test",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
  })
  assert.deepEqual(fallback.content, [{ type: "text", text: "OK" }])
  assert.equal(
    (
      await anthropic.messages.countTokens({
        model: "claude-sonnet-4.6",
        messages: [prompt],
      })
    ).input_tokens,
    100,
  )
  assert.equal(
    (
      await post("/v1/messages/count_tokens", {
        model: "chat-test",
        messages: [prompt],
      })
    ).headers.get("x-token-count-estimated"),
    "true",
  )
  assert.equal(
    (await openai.responses.create({ model: "response-test", input: "hi" }))
      .status,
    "completed",
  )
  const responses = await openai.responses.create({
    model: "response-test",
    input: "hi",
    stream: true,
  })
  let completed = false
  for await (const event of responses)
    if (event.type === "response.completed") completed = true
  assert(completed)
  assert.deepEqual(
    (
      await openai.embeddings.create({
        model: "embed-test",
        input: ["hello"],
        encoding_format: "float",
      })
    ).data[0]?.embedding,
    [0.1, 0.2],
  )
  const metrics = (await (await get("/metrics")).json()) as {
    upstreamRetries: number
  }
  assert(metrics.upstreamRetries >= 1)
  assert.equal(await docker("exec", container, "id", "-u"), "1000")
  assert.equal(
    await docker(
      "exec",
      container,
      "bun",
      "-e",
      "console.log(require('node:fs').existsSync('/app/.env'))",
    ),
    "false",
  )
  assert.equal(
    await docker(
      "exec",
      container,
      "bun",
      "-e",
      "console.log((require('node:fs').statSync('/data/copilot-gateway/github-token').mode & 0o777).toString(8))",
    ),
    "600",
  )
  await docker("stop", "--time", "15", container)
  assert.equal(
    await docker("inspect", "--format", "{{.State.ExitCode}}", container),
    "0",
  )
  console.log(
    "Container E2E passed: auth, discovery, models, retries, Chat, Messages, Responses, embeddings, counting, MCP, metrics, non-root runtime and graceful shutdown.",
  )
} finally {
  if (container) await docker("rm", "--force", container).catch(() => {})
  if (volume) await docker("volume", "rm", volume).catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
