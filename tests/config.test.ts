import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { deviceLogin } from "~/auth"
import { loadConfig, loadRuntimeConfig, tokenPath } from "~/config"
import { Gateway } from "~/gateway"
import { CopilotUpstream } from "~/upstream"

import { config, FakeUpstream, request, sse, chunk } from "./helpers"

test("empty optional Docker settings use defaults and invalid settings never disclose values", () => {
  const settings = loadConfig({
    GATEWAY_API_KEY: "valid-client-key-123456",
    COPILOT_API_URL: "",
    MODEL_ALIASES: "",
    CLAUDE_MODEL: "",
  })
  expect(settings.aliases).toEqual({})
  expect(settings.COPILOT_API_URL).toBeUndefined()
  expect(settings.CLAUDE_MODEL).toBeUndefined()
  expect(
    tokenPath({ GITHUB_TOKEN_FILE: "", XDG_DATA_HOME: "/private/data" }),
  ).toBe("/private/data/copilot-gateway/github-token")
  for (const origin of [
    "http://host.example",
    "https://user:secret@host.example",
    "https://host.example/path",
    "https://host.example?secret=yes",
  ])
    expect(() => loadRuntimeConfig({ COPILOT_API_URL: origin })).toThrow(
      "COPILOT_API_URL",
    )
  expect(() => loadRuntimeConfig({ PORT: "secret-value" })).toThrow(
    "Invalid configuration: PORT",
  )
  expect(() => loadRuntimeConfig({ LOG_REQUESTS: "yes" })).toThrow(
    "LOG_REQUESTS",
  )
})

test("local .env settings load and exported environment wins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-env-test-"))
  try {
    await writeFile(join(directory, ".env"), "PORT=4321\nMAX_RETRIES=4\n")
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({port:process.env.PORT,retries:process.env.MAX_RETRIES}))",
      ],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, PORT: "5432" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    expect(await new Response(child.stdout).json()).toEqual({
      port: "5432",
      retries: "4",
    })
    expect(await child.exited).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("OAuth overrides reach both device authorization requests without a gateway key", async () => {
  const calls: Array<{ url: string; body: Record<string, string> }> = []
  const token = await deviceLogin(
    () => {},
    new AbortController().signal,
    async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, string>,
      })
      return Response.json(
        calls.length === 1
          ? {
              device_code: "test-device",
              user_code: "CODE",
              verification_uri: "https://login.example/device",
              expires_in: 60,
              interval: 1,
            }
          : { access_token: "fixture-oauth" },
      )
    },
    async () => {},
    Date.now,
    loadRuntimeConfig({
      GITHUB_LOGIN_URL: "https://login.example/",
      GITHUB_OAUTH_CLIENT_ID: "custom-client",
      GITHUB_OAUTH_SCOPE: "read:user custom:scope",
    }),
  )
  expect(token).toBe("fixture-oauth")
  expect(calls[0]?.url).toBe("https://login.example/login/device/code")
  expect(calls[0]?.body.scope).toBe("read:user custom:scope")
  expect(calls.map((call) => call.body.client_id)).toEqual([
    "custom-client",
    "custom-client",
  ])
})

test("explicit upstream origin and headers override discovered routing, including GitHub refresh", async () => {
  const calls: Array<{ url: string; headers: Headers }> = []
  const upstream = new CopilotUpstream(
    config({
      COPILOT_API_URL: "https://inference.example/",
      GITHUB_API_URL: "https://github-api.example/",
      COPILOT_INTEGRATION_ID: "integration-test",
      COPILOT_INTENT: "intent-test",
      COPILOT_INTERACTION_TYPE: "interaction-test",
      EDITOR_VERSION: "9.8.7",
      PLUGIN_VERSION: "6.5.4",
      COPILOT_API_VERSION: "2026-10-04",
    }),
    "fixture-oauth",
    async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) })
      return String(url).includes("/token")
        ? Response.json({
            token: "fixture-copilot",
            expires_at: Date.now() / 1000 + 3600,
            refresh_in: 1800,
            endpoints: { api: "https://api.githubcopilot.com" },
          })
        : Response.json({ ok: true })
    },
  )
  await upstream.request(
    "/models",
    undefined,
    new AbortController().signal,
    "request-test",
  )
  expect(calls[0]?.url).toBe(
    "https://github-api.example/copilot_internal/v2/token",
  )
  expect(calls[0]?.headers.get("editor-version")).toBe("vscode/9.8.7")
  expect(calls[1]?.url).toBe("https://inference.example/models")
  expect(calls[1]?.headers.get("copilot-integration-id")).toBe(
    "integration-test",
  )
  expect(calls[1]?.headers.get("openai-intent")).toBe("intent-test")
  expect(calls[1]?.headers.get("x-interaction-type")).toBe("interaction-test")
  expect(calls[1]?.headers.get("x-github-api-version")).toBe("2026-10-04")
})

test("logging and stream bounds follow environment settings", async () => {
  const entries: unknown[] = []
  const upstream = new FakeUpstream()
  upstream.respond = () =>
    sse([chunk({ content: "€".repeat(400) }), chunk({}, "stop"), "[DONE]"])
  const gateway = new Gateway(
    config({ LOG_REQUESTS: "false", MAX_SSE_EVENT_BYTES: "1024" }),
    upstream,
    (entry) => entries.push(entry),
  )
  const response = await gateway.handle(
    request("/v1/chat/completions", {
      model: "chat-test",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
  )
  const body = await response.text()
  expect(body).toContain("size limit")
  expect(body).not.toContain("[DONE]")
  expect(entries).toHaveLength(0)
})

test("Claude model overrides resolve aliases and reject unavailable native models", async () => {
  const gateway = new Gateway(
    config({
      CLAUDE_MODEL: "fast",
      CLAUDE_FAST_MODEL: "claude-sonnet-4.6",
      MODEL_ALIASES: '{"fast":"claude-haiku-4.5"}',
    }),
    new FakeUpstream(),
    () => {},
  )
  expect(
    await gateway.catalog.claudeModels(new AbortController().signal),
  ).toEqual({
    primary: "claude-haiku-4.5",
    fast: "claude-sonnet-4.6",
    opus: "claude-haiku-4.5",
  })
  const invalid = new Gateway(
    config({ CLAUDE_MODEL: "disabled" }),
    new FakeUpstream(),
    () => {},
  )
  await expect(
    invalid.catalog.claudeModels(new AbortController().signal),
  ).rejects.toThrow("policy-allowed native Claude")
})
