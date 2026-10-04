import { chmod, readFile, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { deviceLogin, readGithubToken, writeGithubToken } from "~/auth"
import { claudeArguments, claudeEnvironment } from "~/claude"
import { loadConfig, tokenPath } from "~/config"
import { Gateway } from "~/gateway"
import { catalogSummary } from "~/models"
import { CopilotUpstream } from "~/upstream"

async function initialize() {
  if (process.env.GATEWAY_API_KEY) return
  const path = resolve(".env")
  try {
    const existing = await readFile(path, "utf8")
    const key = existing.match(/^GATEWAY_API_KEY=([a-f\d]{64})$/m)?.[1]
    if (key) {
      process.env.GATEWAY_API_KEY = key
      await chmod(path, 0o600)
      return
    }
    throw new Error(
      "Existing .env has no valid GATEWAY_API_KEY. Add a key with at least 16 characters before starting.",
    )
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error
  }
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "hex",
  )
  await writeFile(path, `GATEWAY_API_KEY=${key}\n`, { mode: 0o600, flag: "wx" })
  process.env.GATEWAY_API_KEY = key
  console.log("Created .env with a private gateway key.")
}

async function authenticate() {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once("SIGINT", interrupt)
  try {
    const token = await deviceLogin(
      (code, uri) => console.log(`Open ${uri} and enter ${code}.`),
      controller.signal,
    )
    await writeGithubToken(tokenPath(process.env), token)
    console.log("GitHub credential saved privately.")
  } finally {
    process.removeListener("SIGINT", interrupt)
  }
}

async function main() {
  const command = process.argv[2] ?? "start"
  if (["--help", "-h", "help"].includes(command)) {
    console.log(
      "copilot-gateway: setup | auth | start | doctor | claude [Claude Code arguments]\n\nsetup creates a gateway key, signs in when needed, and checks model discovery.\nclaude starts the gateway and launches the installed Claude Code CLI.\nConfiguration: .env / environment; see .env.example.",
    )
    return
  }
  if (command === "auth") {
    await authenticate()
    return
  }
  if (!["setup", "start", "doctor", "claude"].includes(command))
    throw new Error(`Unknown command: ${command}. Use --help.`)
  await initialize()
  const config = loadConfig()
  let githubToken: string
  try {
    githubToken = await readGithubToken(process.env, config.tokenFile)
  } catch (error) {
    if (command !== "setup") throw error
    await authenticate()
    githubToken = await readGithubToken(process.env, config.tokenFile)
  }
  const upstream = new CopilotUpstream(config, githubToken)
  const gateway = new Gateway(config, upstream)
  const catalog = await gateway.catalog.list(
    AbortSignal.timeout(config.STARTUP_TIMEOUT_MS),
  )
  if (command === "setup" || command === "doctor") {
    console.log(
      JSON.stringify(
        {
          status: "ready",
          ...catalogSummary(catalog.data),
          host: config.HOST,
          port: config.PORT,
        },
        null,
        2,
      ),
    )
    console.log(
      "Run bun start for OpenAI/Anthropic clients, or bun run claude for Claude Code with native Claude access.",
    )
    return
  }
  const executable =
    command === "claude" ? Bun.which(config.CLAUDE_BIN) : undefined
  if (command === "claude" && !executable)
    throw new Error(
      "Claude Code CLI is not installed or not in PATH. Install it before running bun run claude.",
    )
  const models =
    command === "claude"
      ? await gateway.catalog.claudeModels(
          AbortSignal.timeout(config.STARTUP_TIMEOUT_MS),
        )
      : undefined
  const server = Bun.serve({
    hostname: config.HOST,
    port: config.PORT,
    maxRequestBodySize: config.MAX_BODY_BYTES,
    idleTimeout: config.SERVER_IDLE_TIMEOUT_SECONDS,
    fetch: async (request, server) => {
      // Application deadlines cover inference and streaming; the server's default
      // idle timeout would otherwise interrupt long thinking before first bytes.
      // Keep the idle limit while receiving the body. Only complete bodies
      // enter the longer application deadline for inference and streaming.
      return gateway.handle(request, () => server.timeout(request, 0))
    },
  })
  console.log(`Copilot gateway listening at ${server.url}`)
  let child: ReturnType<typeof Bun.spawn> | undefined
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    gateway.drain()
    child?.kill("SIGTERM")
    const force = setTimeout(() => {
      gateway.abort()
      void server.stop(true)
    }, config.SHUTDOWN_GRACE_MS)
    force.unref()
    try {
      await server.stop(false)
    } finally {
      clearTimeout(force)
    }
  }
  const interrupt = () => {
    void shutdown().catch(() => {
      process.exitCode = 1
    })
  }
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  if (executable && models) {
    try {
      const launch = claudeArguments(
        process.argv.slice(3),
        config.CLAUDE_PROJECT ?? process.cwd(),
      )
      if (!(await stat(launch.cwd)).isDirectory())
        throw new Error("Claude project path must be a directory")
      child = Bun.spawn([executable, ...launch.args], {
        cwd: launch.cwd,
        env: claudeEnvironment(config, models),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })
      process.exitCode = await child.exited
    } finally {
      await shutdown()
      process.removeListener("SIGINT", interrupt)
      process.removeListener("SIGTERM", interrupt)
    }
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gateway failed")
    process.exitCode = 1
  }
}
