import { z } from "zod"

import type { Config } from "~/config"
import type { Upstream } from "~/upstream"

import { GatewayError } from "~/errors"
import { readJson } from "~/io"
import { withSignal } from "~/lifecycle"

const modelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    model_picker_enabled: z.boolean().optional(),
    supported_endpoints: z.array(z.string()).optional(),
    policy: z.object({ state: z.string().optional() }).passthrough().optional(),
    capabilities: z
      .object({
        type: z.string().optional(),
        family: z.string().optional(),
        tokenizer: z.string().optional(),
        limits: z
          .object({
            max_output_tokens: z.number().positive().optional(),
            max_context_window_tokens: z.number().positive().optional(),
            max_prompt_tokens: z.number().positive().optional(),
          })
          .passthrough()
          .optional(),
        supports: z
          .object({
            tool_calls: z.boolean().optional(),
            streaming: z.boolean().optional(),
            vision: z.boolean().optional(),
            reasoning_effort: z.array(z.string()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
const modelsSchema = z
  .object({ data: z.array(modelSchema), object: z.string().optional() })
  .passthrough()
export type Model = z.infer<typeof modelSchema>

// Older catalog entries omit supported_endpoints. Only infer their established
// legacy protocol from the capability type; native Messages/Responses require
// an explicit advertisement.
export function modelSupportsEndpoint(model: Model, endpoint: string): boolean {
  if (model.supported_endpoints)
    return model.supported_endpoints.includes(endpoint)
  return (
    (endpoint === "/chat/completions" && model.capabilities?.type === "chat") ||
    (endpoint === "/embeddings" && model.capabilities?.type === "embeddings")
  )
}

export function catalogSummary(models: Model[]) {
  const allowed = models.filter((model) => model.policy?.state !== "disabled")
  const endpoints = {
    chatCompletions: "/chat/completions",
    responses: "/responses",
    messages: "/v1/messages",
    embeddings: "/embeddings",
  }
  return {
    catalogModels: models.length,
    policyAllowedModels: allowed.length,
    protocols: Object.fromEntries(
      Object.entries(endpoints).map(([protocol, endpoint]) => [
        protocol,
        allowed
          .filter((model) => modelSupportsEndpoint(model, endpoint))
          .map((model) => model.id),
      ]),
    ),
    availability:
      "Catalog metadata only. Run bun run test:live to verify inference access.",
  }
}

export class ModelCatalog {
  private cached?: z.infer<typeof modelsSchema>
  private expiresAt = 0
  private pending?: Promise<z.infer<typeof modelsSchema>>
  private lastForcedRefresh = 0

  constructor(
    private readonly upstream: Upstream,
    private readonly config: Config,
    private readonly now = Date.now,
  ) {}

  async list(signal: AbortSignal, force = false) {
    if (!force && this.cached && this.expiresAt > this.now()) return this.cached
    if (!this.pending) {
      // Discovery has its own bounded lifecycle. One caller cancelling must not
      // cancel a refresh shared by other requests.
      this.pending = this.refresh().finally(() => {
        this.pending = undefined
      })
    }
    return withSignal(this.pending, signal)
  }

  private async refresh() {
    const signal = AbortSignal.timeout(15000)
    const response = await this.upstream.request(
      "/models",
      undefined,
      signal,
      crypto.randomUUID(),
    )
    const parsed = modelsSchema.safeParse(
      await readJson(response.body, 8388608, signal, true),
    )
    if (!parsed.success)
      throw new GatewayError(
        502,
        "api_error",
        "Copilot returned an invalid model catalog",
      )
    this.cached = parsed.data
    this.expiresAt = this.now() + this.config.MODEL_CACHE_TTL_MS
    return parsed.data
  }

  async resolve(name: string, signal: AbortSignal): Promise<Model> {
    const id = Object.hasOwn(this.config.aliases, name)
      ? this.config.aliases[name]
      : name
    const find = (catalog: z.infer<typeof modelsSchema>) =>
      catalog.data.find((model) => model.id === id)
    let model = find(await this.list(signal))
    if (!model && this.now() - this.lastForcedRefresh >= 5000) {
      this.lastForcedRefresh = this.now()
      model = find(await this.list(signal, true))
    }
    if (!model)
      throw new GatewayError(
        404,
        "not_found_error",
        `Unknown model: ${name}. Choose an ID from /v1/models or configure MODEL_ALIASES.`,
      )
    if (model.policy?.state === "disabled")
      throw new GatewayError(
        403,
        "permission_error",
        `Model ${name} is disabled by Copilot policy`,
      )
    return model
  }

  validate(model: Model, endpoint: string, payload: Record<string, unknown>) {
    if (
      (model.supported_endpoints || model.capabilities?.type) &&
      !modelSupportsEndpoint(model, endpoint)
    )
      throw new GatewayError(
        400,
        "invalid_request_error",
        `Model ${model.id} does not support ${endpoint}. Supported endpoints: ${model.supported_endpoints?.join(", ") ?? model.capabilities?.type ?? "unknown"}`,
      )
    const supports = model.capabilities?.supports
    if (payload.stream && supports?.streaming === false)
      throw new GatewayError(
        400,
        "invalid_request_error",
        `Model ${model.id} does not support streaming`,
      )
    if (
      Array.isArray(payload.tools) &&
      payload.tools.length &&
      supports?.tool_calls === false
    )
      throw new GatewayError(
        400,
        "invalid_request_error",
        `Model ${model.id} does not support tools`,
      )
    const maximum = model.capabilities?.limits?.max_output_tokens
    const requested =
      payload.max_completion_tokens ??
      payload.max_output_tokens ??
      payload.max_tokens
    if (maximum && typeof requested === "number" && requested > maximum)
      throw new GatewayError(
        400,
        "invalid_request_error",
        `Requested output exceeds model limit (${maximum})`,
      )
    const effort =
      typeof payload.reasoning === "object" &&
      payload.reasoning !== null &&
      "effort" in payload.reasoning
        ? payload.reasoning.effort
        : payload.reasoning_effort
    if (
      typeof effort === "string" &&
      supports?.reasoning_effort &&
      !supports.reasoning_effort.includes(effort)
    )
      throw new GatewayError(
        400,
        "invalid_request_error",
        `Unsupported reasoning effort for model ${model.id}`,
      )
    if (
      supports?.vision === false &&
      containsImage(payload.messages ?? payload.input)
    )
      throw new GatewayError(
        400,
        "invalid_request_error",
        `Model ${model.id} does not support images`,
      )
  }

  async claudeModels(
    signal: AbortSignal,
  ): Promise<{ primary: string; fast: string; opus: string }> {
    const models = (await this.list(signal)).data.filter(
      (model) =>
        model.policy?.state !== "disabled" &&
        model.id.includes("claude") &&
        model.supported_endpoints?.includes("/v1/messages"),
    )
    const newest = (family: string) =>
      models
        .filter((model) => model.id.includes(family))
        .sort(
          (a, b) =>
            Number(b.model_picker_enabled ?? true) -
              Number(a.model_picker_enabled ?? true) ||
            b.id.localeCompare(a.id, undefined, { numeric: true }),
        )[0]
    const primary = newest("sonnet") ?? newest("opus") ?? newest("haiku")
    if (!primary)
      throw new GatewayError(
        503,
        "api_error",
        "No accessible native Claude model found. Check your Copilot model policy.",
      )
    return {
      primary: primary.id,
      fast: (newest("haiku") ?? primary).id,
      opus: (newest("opus") ?? primary).id,
    }
  }
}

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage)
  if (!value || typeof value !== "object") return false
  const block = value as Record<string, unknown>
  return (
    ["image", "image_url", "input_image"].includes(String(block.type)) ||
    containsImage(block.content)
  )
}
