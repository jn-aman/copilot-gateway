import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback)

const configSchema = z.object({
  GATEWAY_API_KEY: z.string().min(16).max(512),
  HOST: z.string().min(1).default("127.0.0.1"),
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
    env.GITHUB_TOKEN_FILE ??
    join(
      env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
      "copilot-gateway",
      "github-token",
    )
  )
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const result = configSchema.safeParse(env)
  if (!result.success) {
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    )
  }
  let aliases: Record<string, string>
  try {
    aliases = z
      .record(z.string().min(1), z.string().min(1))
      .parse(JSON.parse(result.data.MODEL_ALIASES))
  } catch {
    throw new Error(
      "MODEL_ALIASES must be a JSON object mapping names to model IDs",
    )
  }
  return { ...result.data, aliases, tokenFile: tokenPath(env) }
}

export type Config = ReturnType<typeof loadConfig>
