import type { Config } from "~/config"

export function claudeArguments(
  arguments_: string[],
  cwd = process.cwd(),
): { cwd: string; args: string[] } {
  const args: string[] = []
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!
    if (argument === "--") {
      args.push(...arguments_.slice(index + 1))
      break
    }
    if (argument === "--project") {
      const directory = arguments_[++index]
      if (!directory || directory.startsWith("--"))
        throw new Error("--project requires a working directory")
      cwd = directory
    } else args.push(argument)
  }
  return { cwd, args }
}

export function claudeEnvironment(
  config: Config,
  models: { primary: string; fast: string; opus?: string },
  inherited: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(inherited).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  // Avoid inherited credentials/provider switches routing this child elsewhere.
  for (const key of Object.keys(env)) {
    if (
      key === "ANTHROPIC_API_KEY" ||
      key === "ANTHROPIC_CUSTOM_HEADERS" ||
      key.startsWith("CLAUDE_CODE_USE_") ||
      key.startsWith("ANTHROPIC_DEFAULT_") ||
      key === "CLAUDE_CODE_SUBAGENT_MODEL" ||
      key === "GITHUB_TOKEN" ||
      key === "GATEWAY_API_KEY"
    )
      delete env[key]
  }
  const host =
    config.HOST === "0.0.0.0"
      ? "127.0.0.1"
      : config.HOST === "::"
        ? "[::1]"
        : config.HOST.includes(":")
          ? `[${config.HOST}]`
          : config.HOST
  return {
    ...env,
    ANTHROPIC_BASE_URL: `http://${host}:${config.PORT}`,
    ANTHROPIC_AUTH_TOKEN: config.GATEWAY_API_KEY,
    ANTHROPIC_MODEL: models.primary,
    ANTHROPIC_DEFAULT_SONNET_MODEL: models.primary,
    ANTHROPIC_DEFAULT_OPUS_MODEL: models.opus ?? models.primary,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: models.fast,
    ANTHROPIC_SMALL_FAST_MODEL: models.fast,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY:
      config.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY,
    CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS: String(
      config.CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS,
    ),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
      config.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  }
}
