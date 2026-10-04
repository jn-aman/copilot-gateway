import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback)

const runtimeSchema = z.object({
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: integer(4141, 1, 65535),
  ACCOUNT_TYPE: z
    .enum(["individual", "business", "enterprise"])
    .default("individual"),
  REQUEST_TIMEOUT_MS: integer(300000, 100, 600000),
  MAX_CONCURRENT_REQUESTS: integer(8, 1, 64),
  MIN_REQUEST_INTERVAL_MS: integer(0, 0, 60000),
  MAX_BODY_BYTES: integer(4194304, 1024, 67108864),
  MAX_RETRIES: integer(2, 0, 5),
  MAX_RETRY_DELAY_MS: integer(10000, 100, 60000),
  MODEL_CACHE_TTL_MS: integer(60000, 1000, 3600000),
  MODEL_REFRESH_TIMEOUT_MS: integer(15000, 100, 600000),
  MODEL_REFRESH_COOLDOWN_MS: integer(5000, 0, 60000),
  STARTUP_TIMEOUT_MS: integer(20000, 100, 600000),
  SERVER_IDLE_TIMEOUT_SECONDS: integer(30, 1, 255),
  SHUTDOWN_GRACE_MS: integer(10000, 0, 600000),
  MAX_RESPONSE_BYTES: integer(16777216, 1024, 268435456),
  MAX_CATALOG_BYTES: integer(8388608, 1024, 67108864),
  MAX_SSE_EVENT_BYTES: integer(1048576, 1024, 67108864),
  MAX_TOOL_BUFFER_BYTES: integer(4194304, 1024, 67108864),
  MAX_PARALLEL_TOOLS: integer(128, 1, 1024),
  LOG_REQUESTS: z.enum(["true", "false"]).default("true"),
  COPILOT_API_URL: z.url().optional(),
  COPILOT_INTEGRATION_ID: z.string().min(1).default("vscode-chat"),
  COPILOT_INTENT: z.string().min(1).default("conversation-panel"),
  COPILOT_INTERACTION_TYPE: z.string().min(1).default("conversation-panel"),
  GITHUB_API_URL: z.url().default("https://api.github.com"),
  GITHUB_LOGIN_URL: z.url().default("https://github.com"),
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1).default("Iv1.b507a08c87ecfe98"),
  GITHUB_OAUTH_SCOPE: z.string().default("read:user"),
  GITHUB_REQUEST_TIMEOUT_MS: integer(15000, 100, 600000),
  GITHUB_MAX_RETRIES: integer(2, 0, 5),
  GITHUB_MAX_RETRY_DELAY_MS: integer(5000, 100, 60000),
  TOKEN_REFRESH_COOLDOWN_MS: integer(5000, 0, 60000),
  TOKEN_REFRESH_SKEW_MS: integer(60000, 0, 600000),
  CLAUDE_BIN: z.string().min(1).default("claude"),
  CLAUDE_PROJECT: z.string().min(1).optional(),
  CLAUDE_MODEL: z.string().min(1).optional(),
  CLAUDE_FAST_MODEL: z.string().min(1).optional(),
  CLAUDE_OPUS_MODEL: z.string().min(1).optional(),
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: z.enum(["0", "1"]).default("1"),
  CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS: integer(15000, 100, 600000),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: z.enum(["0", "1"]).default("1"),
  COPILOT_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default("2026-06-01"),
  MODEL_ALIASES: z.string().default("{}"),
  EDITOR_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default("1.115.0"),
  PLUGIN_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default("0.44.0"),
})

export function tokenPath(env: Record<string, string | undefined>): string {
  return (
    env.GITHUB_TOKEN_FILE ||
    join(
      env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      "copilot-gateway",
      "github-token",
    )
  )
}

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const values = { ...env }
  for (const key of [
    "MODEL_ALIASES",
    "COPILOT_API_URL",
    "CLAUDE_PROJECT",
    "CLAUDE_MODEL",
    "CLAUDE_FAST_MODEL",
    "CLAUDE_OPUS_MODEL",
  ])
    if (values[key] === "") delete values[key]
  const result = runtimeSchema.safeParse(values)
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    )
  for (const key of [
    "GITHUB_API_URL",
    "GITHUB_LOGIN_URL",
    "COPILOT_API_URL",
  ] as const) {
    const value = result.data[key]
    if (!value) continue
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error(`Invalid configuration: ${key} must be an HTTPS origin`)
    result.data[key] = url.origin
  }
  return result.data
}

export type RuntimeConfig = ReturnType<typeof loadRuntimeConfig>

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const runtime = loadRuntimeConfig(env)
  const key = z.string().min(16).max(512).safeParse(env.GATEWAY_API_KEY)
  if (!key.success) throw new Error("Invalid configuration: GATEWAY_API_KEY")
  let aliases: Record<string, string>
  try {
    aliases = z
      .record(z.string().min(1), z.string().min(1))
      .parse(JSON.parse(runtime.MODEL_ALIASES))
  } catch {
    throw new Error(
      "MODEL_ALIASES must be a JSON object mapping names to model IDs",
    )
  }
  return {
    ...runtime,
    GATEWAY_API_KEY: key.data,
    aliases,
    tokenFile: tokenPath(env),
  }
}

export type Config = ReturnType<typeof loadConfig>
