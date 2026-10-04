import { expect, test } from "bun:test"

import type { Fetcher } from "~/auth"

import { GatewayError } from "~/errors"
import { CopilotUpstream } from "~/upstream"

import { config } from "./helpers"

function credential(token = "copilot-secret") {
  return Response.json({
    token,
    expires_at: Date.now() / 1000 + 3600,
    refresh_in: 1800,
    endpoints: { api: "https://api.business.githubcopilot.com" },
  })
}

test("discovered API host and the latest configured API version are used", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url: String(url), init })
    return String(url).includes("copilot_internal")
      ? credential()
      : Response.json({ ok: true })
  }
  const upstream = new CopilotUpstream(config(), "github-secret", fetcher)
  await upstream.request(
    "/responses",
    { model: "model", input: "hi" },
    new AbortController().signal,
    "request-1",
  )
  expect(calls[1]?.url).toBe("https://api.business.githubcopilot.com/responses")
  const headers = new Headers(calls[1]?.init?.headers)
  expect(headers.get("authorization")).toBe("Bearer copilot-secret")
  expect(headers.get("x-github-api-version")).toBe("2026-06-01")
  expect(headers.get("x-initiator")).toBe("user")
  expect(calls[1]?.init?.redirect).toBe("error")
})

test("user initiation follows the latest turn, not earlier assistant history", async () => {
  const initiators: Array<string | null> = []
  const fetcher: Fetcher = async (url, init) => {
    if (String(url).includes("copilot_internal")) return credential()
    initiators.push(new Headers(init?.headers).get("x-initiator"))
    return Response.json({ ok: true })
  }
  const upstream = new CopilotUpstream(config(), "github-secret", fetcher)
  const signal = new AbortController().signal
  await upstream.request(
    "/chat/completions",
    {
      messages: [
        { role: "assistant", content: "previous" },
        { role: "user", content: "new prompt" },
      ],
    },
    signal,
    "id",
  )
  await upstream.request(
    "/chat/completions",
    { messages: [{ role: "tool", content: "result" }] },
    signal,
    "id",
  )
  await upstream.request(
    "/v1/messages",
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call", content: "result" },
          ],
        },
      ],
    },
    signal,
    "id",
  )
  expect(initiators).toEqual(["user", "agent", "agent"])
})

test("images inside tool results enable the vision header", async () => {
  let headers = new Headers()
  const upstream = new CopilotUpstream(
    config(),
    "github-secret",
    async (url, init) => {
      if (String(url).includes("copilot_internal")) return credential()
      headers = new Headers(init?.headers)
      return Response.json({ ok: true })
    },
  )
  await upstream.request(
    "/v1/messages",
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    data: "YWJj",
                    media_type: "image/png",
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    new AbortController().signal,
    "id",
  )
  expect(headers.get("copilot-vision-request")).toBe("true")
})

test("401 refreshes once and retries using the replacement credential", async () => {
  let tokenCalls = 0
  let generations = 0
  const headers: string[] = []
  const upstream = new CopilotUpstream(
    config(),
    "github-secret",
    async (url, init) => {
      if (String(url).includes("copilot_internal"))
        return credential(`copilot-secret-${++tokenCalls}`)
      headers.push(new Headers(init?.headers).get("authorization")!)
      return ++generations === 1
        ? Response.json({ error: "expired" }, { status: 401 })
        : Response.json({ ok: true })
    },
  )
  expect(
    (
      await upstream.request(
        "/chat/completions",
        { model: "test" },
        new AbortController().signal,
        "id",
      )
    ).status,
  ).toBe(200)
  expect(headers).toEqual([
    "Bearer copilot-secret-1",
    "Bearer copilot-secret-2",
  ])
  expect(upstream.retryCount).toBe(1)
})

test("persistent authorization failure stops after one refresh", async () => {
  let generations = 0
  const upstream = new CopilotUpstream(
    config(),
    "github-secret",
    async (url) =>
      String(url).includes("copilot_internal")
        ? credential()
        : (generations++,
          Response.json(
            { error: { message: "unauthorized" } },
            { status: 401 },
          )),
  )
  await expect(
    upstream.request(
      "/chat/completions",
      {},
      new AbortController().signal,
      "id",
    ),
  ).rejects.toThrow()
  expect(generations).toBe(2)
})

test("upstream errors retain rejection detail but redact credentials", async () => {
  const upstream = new CopilotUpstream(
    config(),
    "github-secret",
    async (url) =>
      String(url).includes("copilot_internal")
        ? credential()
        : Response.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "thinking: rejected copilot-secret github-secret",
              },
            },
            { status: 400, headers: { "x-should-retry": "false" } },
          ),
  )
  try {
    await upstream.request(
      "/v1/messages",
      {},
      new AbortController().signal,
      "id",
    )
    throw new Error("Expected failure")
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError)
    if (!(error instanceof GatewayError)) throw error
    expect(error.status).toBe(400)
    expect(JSON.stringify(error.body)).toContain("thinking: rejected")
    expect(JSON.stringify(error.body)).not.toContain("copilot-secret")
    expect(JSON.stringify(error.body)).not.toContain("github-secret")
    expect(error.headers?.get("x-should-retry")).toBe("false")
  }
})

test("plain-text upstream errors preserve bounded detail and redact credentials", async () => {
  const upstream = new CopilotUpstream(
    config(),
    "github-secret",
    async (url) =>
      String(url).includes("copilot_internal")
        ? credential()
        : new Response(
            "unsupported input: copilot-secret github-secret " +
              "x".repeat(3000),
            { status: 400 },
          ),
  )
  try {
    await upstream.request(
      "/embeddings",
      {},
      new AbortController().signal,
      "id",
    )
    throw new Error("Expected failure")
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError)
    if (!(error instanceof GatewayError)) throw error
    expect(error.status).toBe(400)
    expect(error.message).toContain("unsupported input")
    expect(error.message).not.toContain("copilot-secret")
    expect(error.message).not.toContain("github-secret")
    expect(error.message.length).toBeLessThanOrEqual(2048)
  }
})
