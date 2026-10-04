import { expect, test } from "bun:test"

import { claudeArguments, claudeEnvironment } from "~/claude"
import { Gateway } from "~/gateway"

import { config, FakeUpstream } from "./helpers"

test("launcher selects a project directory and preserves Claude MCP arguments", () => {
  expect(
    claudeArguments(
      [
        "--project",
        "/projects/example",
        "--mcp-config",
        "mcp.json",
        "--print",
        "hello",
      ],
      "/gateway",
    ),
  ).toEqual({
    cwd: "/projects/example",
    args: ["--mcp-config", "mcp.json", "--print", "hello"],
  })
  expect(claudeArguments(["--", "--project", "literal"], "/gateway")).toEqual({
    cwd: "/gateway",
    args: ["--project", "literal"],
  })
  expect(() => claudeArguments(["--project"])).toThrow("working directory")
})

test("launcher sets primary, fast and opus models and removes conflicting providers", () => {
  const env = claudeEnvironment(
    config(),
    {
      primary: "claude-sonnet-4.6",
      fast: "claude-haiku-4.5",
      opus: "claude-opus-4.6",
    },
    {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "other-key",
      ANTHROPIC_CUSTOM_HEADERS: "Authorization: wrong",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_SUBAGENT_MODEL: "wrong-model",
      GITHUB_TOKEN: "secret",
      GATEWAY_API_KEY: "secret",
    },
  )
  expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4141")
  expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-4.6")
  expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-4.5")
  expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4.6")
  expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1")
  for (const key of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "ANTHROPIC_CUSTOM_HEADERS",
    "GITHUB_TOKEN",
    "GATEWAY_API_KEY",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ])
    expect(env[key]).toBeUndefined()
})

test("launcher formats IPv6 and wildcard bind hosts as connectable URLs", () => {
  expect(
    claudeEnvironment(
      config({ HOST: "::" }),
      { primary: "claude", fast: "claude" },
      {},
    ).ANTHROPIC_BASE_URL,
  ).toBe("http://[::1]:4141")
  expect(
    claudeEnvironment(
      config({ HOST: "0.0.0.0" }),
      { primary: "claude", fast: "claude" },
      {},
    ).ANTHROPIC_BASE_URL,
  ).toBe("http://127.0.0.1:4141")
})

test("Claude models are selected from current accessible native endpoints", async () => {
  const gateway = new Gateway(config(), new FakeUpstream(), () => {})
  expect(
    await gateway.catalog.claudeModels(new AbortController().signal),
  ).toEqual({
    primary: "claude-sonnet-4.6",
    fast: "claude-haiku-4.5",
    opus: "claude-sonnet-4.6",
  })
})
