import { z } from "zod"

const jsonObject = z.record(z.string(), z.unknown())
const text = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: jsonObject.optional(),
})
const imageSource = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("base64"),
    media_type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    data: z.string().min(1),
  }),
  z.object({
    type: z.literal("url"),
    url: z
      .url()
      .refine((url) => url.startsWith("https://"), "Image URL must use HTTPS"),
  }),
])
const image = z.object({ type: z.literal("image"), source: imageSource })
const toolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: jsonObject,
})
const toolResult = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(z.union([text, image]))]).optional(),
  is_error: z.boolean().optional(),
})
const openaiPart = z.object({ type: z.string().min(1) }).passthrough()
const toolCall = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
})
const openaiMessage = z
  .object({
    role: z.enum([
      "system",
      "developer",
      "user",
      "assistant",
      "tool",
      "function",
    ]),
    content: z.union([z.string(), z.array(openaiPart), z.null()]).optional(),
    tool_calls: z
      .array(
        z
          .object({ id: z.string().min(1), type: z.string().min(1) })
          .passthrough(),
      )
      .optional(),
    tool_call_id: z.string().optional(),
  })
  .passthrough()
  .superRefine((message, ctx) => {
    if (message.role === "tool" && !message.tool_call_id)
      ctx.addIssue({
        code: "custom",
        path: ["tool_call_id"],
        message: "Tool messages require tool_call_id",
      })
    if (
      message.content == null &&
      !(
        message.role === "assistant" &&
        (message.tool_calls?.length ||
          message.audio ||
          message.refusal ||
          message.function_call)
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "Message content is required",
      })
  })

export const chatSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(openaiMessage).min(1),
    stream: z.boolean().default(false),
    max_tokens: z.number().int().positive().nullable().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    top_p: z.number().min(0).max(1).nullable().optional(),
    n: z.number().int().min(1).max(16).optional(),
    tools: z
      .array(z.object({ type: z.string().min(1) }).passthrough())
      .nullable()
      .optional(),
  })
  .passthrough()

export const messagesSchema = z.strictObject({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  stream: z.boolean().default(false),
  messages: z
    .array(
      z.discriminatedUnion("role", [
        z.object({
          role: z.literal("user"),
          content: z.union([
            z.string(),
            z.array(z.union([text, image, toolResult])).min(1),
          ]),
        }),
        z.object({
          role: z.literal("assistant"),
          content: z.union([
            z.string(),
            z.array(z.union([text, toolUse])).min(1),
          ]),
        }),
      ]),
    )
    .min(1),
  system: z.union([z.string(), z.array(text)]).optional(),
  tools: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        input_schema: jsonObject,
        cache_control: jsonObject.optional(),
      }),
    )
    .optional(),
  tool_choice: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("auto"),
        disable_parallel_tool_use: z.boolean().optional(),
      }),
      z.object({
        type: z.literal("any"),
        disable_parallel_tool_use: z.boolean().optional(),
      }),
      z.object({
        type: z.literal("tool"),
        name: z.string().min(1),
        disable_parallel_tool_use: z.boolean().optional(),
      }),
      z.object({ type: z.literal("none") }),
    ])
    .optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z.object({ user_id: z.string().optional() }).optional(),
  thinking: z.object({ type: z.literal("disabled") }).optional(),
})
export const countTokensSchema = messagesSchema
  .omit({ max_tokens: true, stream: true })
  .extend({
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
  })
export const embeddingsSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([
      z.string().min(1),
      z.array(z.string().min(1)).min(1),
      z.array(z.number().int().nonnegative()).min(1),
      z.array(z.array(z.number().int().nonnegative()).min(1)).min(1),
    ]),
    dimensions: z.number().int().positive().optional(),
    encoding_format: z.enum(["float", "base64"]).optional(),
  })
  .passthrough()

export const usageSchema = z
  .object({
    prompt_tokens: z.number().nonnegative(),
    completion_tokens: z.number().nonnegative(),
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().nonnegative().optional() })
      .nullish(),
  })
  .passthrough()
const finishReason = z
  .enum(["stop", "length", "tool_calls", "content_filter", "function_call"])
  .nullable()
export const completionSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    choices: z
      .array(
        z.object({
          index: z.number().int(),
          message: z
            .object({
              role: z.literal("assistant"),
              content: z.string().nullable(),
              tool_calls: z.array(toolCall).optional(),
            })
            .passthrough(),
          finish_reason: finishReason,
        }),
      )
      .min(1),
    usage: usageSchema.nullish(),
  })
  .passthrough()
export const chunkSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    choices: z.array(
      z.object({
        index: z.number().int(),
        delta: z
          .object({
            content: z.string().nullish(),
            role: z.string().optional(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative(),
                  id: z.string().optional(),
                  function: z
                    .object({
                      name: z.string().optional(),
                      arguments: z.string().optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
          })
          .passthrough(),
        finish_reason: finishReason.default(null),
      }),
    ),
    usage: usageSchema.nullish(),
  })
  .passthrough()

export type MessagesPayload = z.infer<typeof messagesSchema>
export type Completion = z.infer<typeof completionSchema>
export type Chunk = z.infer<typeof chunkSchema>
export type Usage = z.infer<typeof usageSchema>

// Native Chat keeps evolving tool kinds, deltas, reasoning and provider
// metadata. The translating adapter above validates its narrower subset.
export const nativeCompletionSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    choices: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            message: z.object({ role: z.literal("assistant") }).passthrough(),
            finish_reason: z.string().nullable(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough()
export const nativeChunkSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    choices: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          delta: jsonObject,
          finish_reason: z.string().nullable().default(null),
        })
        .passthrough(),
    ),
  })
  .passthrough()

export const nativeMessageResponseSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("message"),
    role: z.literal("assistant"),
    model: z.string().min(1),
    content: z.array(z.object({ type: z.string().min(1) }).passthrough()),
    usage: z
      .object({
        input_tokens: z.number().nonnegative(),
        output_tokens: z.number().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough()
export const nativeResponseSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("response"),
    status: z.string().min(1),
    output: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough()
export const embeddingResponseSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          embedding: z.union([z.string(), z.array(z.number())]),
        })
        .passthrough(),
    ),
    model: z.string().min(1),
    usage: z
      .object({
        prompt_tokens: z.number().nonnegative(),
        total_tokens: z.number().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough()

// Native routes validate the envelope and preserve evolving provider-specific
// blocks, tool definitions, thinking signatures, and context-management fields.
export const nativeMessagesSchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive(),
    stream: z.boolean().default(false),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant", "system"]),
            content: z.union([
              z.string(),
              z
                .array(z.object({ type: z.string().min(1) }).passthrough())
                .min(1),
            ]),
          })
          .passthrough(),
      )
      .min(1),
    tools: z.array(jsonObject).optional(),
  })
  .passthrough()
export const nativeCountSchema = nativeMessagesSchema
  .omit({ max_tokens: true, stream: true })
  .extend({ max_tokens: z.number().int().positive().optional() })
export const responsesSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(jsonObject)]).optional(),
    previous_response_id: z.string().min(1).optional(),
    stream: z.boolean().default(false),
    max_output_tokens: z.number().int().positive().optional(),
    tools: z.array(jsonObject).optional(),
    background: z.literal(false).optional(),
  })
  .passthrough()
  .refine(
    (request) => request.input !== undefined || request.previous_response_id,
    "input or previous_response_id is required",
  )
