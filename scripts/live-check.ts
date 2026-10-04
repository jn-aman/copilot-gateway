import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"

import type { Model } from "~/models"

import { readGithubToken } from "~/auth"
import { loadConfig } from "~/config"
import { Gateway } from "~/gateway"
import { modelSupportsEndpoint } from "~/models"
import { CopilotUpstream } from "~/upstream"

// Explicit, bounded checks, outside normal tests. One account rejection must
// not hide the other protocols. Discovery does not establish entitlement.
const config = loadConfig()
const token = await readGithubToken(process.env, config.tokenFile)
const gateway = new Gateway(
  config,
  new CopilotUpstream(config, token),
  () => {},
)
const clientFetch = async (input: string | URL | Request, init?: RequestInit) =>
  gateway.handle(new Request(input, init))
const anthropic = new Anthropic({
  apiKey: config.GATEWAY_API_KEY,
  baseURL: "http://localhost",
  maxRetries: 0,
  fetch: clientFetch,
})
const openai = new OpenAI({
  apiKey: config.GATEWAY_API_KEY,
  baseURL: "http://localhost/v1",
  maxRetries: 0,
  fetch: clientFetch,
})
const report: Record<string, unknown> = {}
const models = (await gateway.catalog.list(AbortSignal.timeout(20000))).data
report.discovery = { status: "ok", catalogModels: models.length }

function choose(endpoint: string, environmentKey: string): Model | undefined {
  const override = process.env[environmentKey]
  if (override) {
    const model = models.find((candidate) => candidate.id === override)
    if (!model) throw new Error(`${environmentKey} is not in the catalog`)
    return model
  }
  return models
    .filter(
      (model) =>
        model.policy?.state !== "disabled" &&
        modelSupportsEndpoint(model, endpoint) &&
        model.capabilities?.supports?.streaming !== false,
    )
    .sort(
      (a, b) =>
        Number(b.model_picker_enabled === true) -
          Number(a.model_picker_enabled === true) ||
        Number(b.policy?.state === "enabled") -
          Number(a.policy?.state === "enabled") ||
        Number(a.supported_endpoints !== undefined) -
          Number(b.supported_endpoints !== undefined),
    )[0]
}

async function probe(
  name: string,
  endpoint: string,
  environmentKey: string,
  operation: (model: Model) => Promise<void>,
) {
  let model: Model | undefined
  try {
    model = choose(endpoint, environmentKey)
    if (!model) {
      report[name] = { status: "not_advertised" }
      return
    }
    await operation(model)
    report[name] = { status: "ok", model: model.id }
  } catch (error) {
    // An upstream refusal fails verification; it is not a successful skip.
    const apiError =
      error instanceof OpenAI.APIError || error instanceof Anthropic.APIError
    report[name] = {
      status:
        apiError && error.status && error.status >= 400 && error.status < 500
          ? "rejected"
          : "failed",
      model: model?.id,
      httpStatus: apiError ? error.status : undefined,
      message: error instanceof Error ? error.message : "Live check failed",
    }
    process.exitCode = 1
  }
  console.log(`${name}: ${JSON.stringify(report[name])}`)
}

try {
  await probe(
    "chatStreamingToolRoundTrip",
    "/chat/completions",
    "LIVE_CHAT_MODEL",
    async (model) => {
      const prompt: OpenAI.Chat.Completions.ChatCompletionUserMessageParam = {
        role: "user",
        content: "Call echo with value LIVE_OK.",
      }
      const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
        {
          type: "function",
          function: {
            name: "echo",
            description: "Echo the given value",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        },
      ]
      const first = await openai.chat.completions.create({
        model: model.id,
        messages: [prompt],
        tools,
        tool_choice: { type: "function", function: { name: "echo" } },
        max_tokens: 128,
        stream: true,
      })
      let id = ""
      let name = ""
      let arguments_ = ""
      let finished = false
      for await (const event of first) {
        const choice = event.choices.find((candidate) => candidate.index === 0)
        for (const call of choice?.delta.tool_calls ?? []) {
          if (call.index !== 0) throw new Error("Unexpected parallel tool call")
          id += call.id ?? ""
          name += call.function?.name ?? ""
          arguments_ += call.function?.arguments ?? ""
        }
        if (choice?.finish_reason === "tool_calls") finished = true
      }
      if (
        !finished ||
        !id ||
        name !== "echo" ||
        !arguments_.includes("LIVE_OK")
      )
        throw new Error(
          "Chat stream did not complete the forced echo tool call",
        )
      JSON.parse(arguments_) as unknown
      const second = await openai.chat.completions.create({
        model: model.id,
        messages: [
          prompt,
          {
            role: "assistant",
            tool_calls: [
              {
                id,
                type: "function",
                function: { name, arguments: arguments_ },
              },
            ],
          },
          { role: "tool", tool_call_id: id, content: "LIVE_OK" },
        ],
        tools,
        tool_choice: "none",
        max_tokens: 128,
        stream: true,
      })
      let text = ""
      for await (const event of second)
        text += event.choices[0]?.delta.content ?? ""
      if (!text.includes("LIVE_OK"))
        throw new Error("Chat tool result was not acknowledged")
    },
  )
  await probe(
    "messagesStreamingToolRoundTrip",
    "/v1/messages",
    "LIVE_MESSAGE_MODEL",
    async (model) => {
      const prompt = {
        role: "user" as const,
        content: "Call echo with value LIVE_OK.",
      }
      const tools: Anthropic.Tool[] = [
        {
          name: "echo",
          description: "Echo the given value",
          input_schema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      ]
      const first = await anthropic.messages
        .stream({
          model: model.id,
          max_tokens: 128,
          messages: [prompt],
          tools,
          tool_choice: { type: "tool", name: "echo" },
        })
        .finalMessage()
      const tool = first.content.find(
        (block) => block.type === "tool_use" && block.name === "echo",
      )
      if (!tool || tool.type !== "tool_use")
        throw new Error(
          "Messages stream did not return the forced echo tool call",
        )
      const second = await anthropic.messages
        .stream({
          model: model.id,
          max_tokens: 128,
          messages: [
            prompt,
            { role: "assistant", content: first.content },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: tool.id,
                  content: "LIVE_OK",
                },
              ],
            },
          ],
          tools,
          tool_choice: { type: "none" },
        })
        .finalMessage()
      if (
        !second.content.some(
          (block) => block.type === "text" && block.text.includes("LIVE_OK"),
        )
      )
        throw new Error("Messages tool result was not acknowledged")
    },
  )
  await probe(
    "responsesStreaming",
    "/responses",
    "LIVE_RESPONSES_MODEL",
    async (model) => {
      const stream = await openai.responses.create({
        model: model.id,
        input: "Reply OK.",
        max_output_tokens: 128,
        stream: true,
      })
      let terminal = false
      for await (const event of stream)
        if (["response.completed", "response.incomplete"].includes(event.type))
          terminal = true
      if (!terminal) throw new Error("Responses stream did not complete")
    },
  )
  await probe(
    "embeddings",
    "/embeddings",
    "LIVE_EMBEDDING_MODEL",
    async (model) => {
      const result = await openai.embeddings.create({
        model: model.id,
        input: ["live check"],
        encoding_format: "float",
      })
      if (!result.data[0]?.embedding.length) throw new Error("Empty embedding")
    },
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  gateway.abort()
}
