import { expect, test } from "bun:test"

import type { Fetcher } from "~/auth"

import { fetchWithRetry, retryDelay } from "~/retry"

test("read requests retry transient failures with bounded backoff", async () => {
  let calls = 0
  const sleeps: number[] = []
  const fetcher: Fetcher = async () =>
    ++calls < 3
      ? new Response(null, { status: 503 })
      : Response.json({ ok: true })
  const response = await fetchWithRetry(
    fetcher,
    "https://example.com",
    { signal: new AbortController().signal },
    {
      retries: 2,
      maxDelayMs: 10000,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    },
  )
  expect(response.status).toBe(200)
  expect(calls).toBe(3)
  expect(sleeps).toEqual([250, 500])
})

test("generation is never replayed on ambiguous network or server failures", async () => {
  for (const network of [false, true]) {
    let calls = 0
    const fetcher: Fetcher = async () => {
      calls++
      if (network) throw new TypeError("network down")
      return new Response(null, { status: 503 })
    }
    const result = fetchWithRetry(
      fetcher,
      "https://example.com",
      { method: "POST", body: "{}", signal: new AbortController().signal },
      { retries: 2, maxDelayMs: 10000 },
    )
    if (network) await expect(result).rejects.toThrow("network down")
    else expect((await result).status).toBe(503)
    expect(calls).toBe(1)
  }
})

test("generation retries a rate-limit rejection and respects Retry-After", async () => {
  let calls = 0
  const sleeps: number[] = []
  const fetcher: Fetcher = async () =>
    ++calls === 1
      ? new Response(null, { status: 429, headers: { "retry-after": "2" } })
      : Response.json({ ok: true })
  const response = await fetchWithRetry(
    fetcher,
    "https://example.com",
    { method: "POST", signal: new AbortController().signal },
    {
      retries: 2,
      maxDelayMs: 10000,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    },
  )
  expect(response.status).toBe(200)
  expect(sleeps).toEqual([2000])
})

test("long server cooldowns and explicit no-retry hints are returned to the client", async () => {
  for (const headers of [
    new Headers({ "retry-after": "1000" }),
    new Headers({ "x-should-retry": "false" }),
  ]) {
    let calls = 0
    const response = await fetchWithRetry(
      async () => {
        calls++
        return new Response(null, { status: 429, headers })
      },
      "https://example.com",
      { signal: new AbortController().signal },
      { retries: 5, maxDelayMs: 10000 },
    )
    expect(response.status).toBe(429)
    expect(calls).toBe(1)
  }
})

test("retry budgets are bounded even when every attempt is rejected", async () => {
  let calls = 0
  const response = await fetchWithRetry(
    async () => {
      calls++
      return new Response(null, {
        status: 429,
        headers: { "retry-after": "0" },
      })
    },
    "https://example.com",
    { signal: new AbortController().signal },
    { retries: 2, maxDelayMs: 1000, sleep: async () => {} },
  )
  expect(response.status).toBe(429)
  expect(calls).toBe(3)
})

test("cancelling during backoff prevents further calls", async () => {
  const controller = new AbortController()
  let calls = 0
  const result = fetchWithRetry(
    async () => {
      calls++
      return new Response(null, { status: 429 })
    },
    "https://example.com",
    { signal: controller.signal },
    {
      retries: 2,
      maxDelayMs: 1000,
      sleep: async () => {
        controller.abort()
      },
    },
  )
  await expect(result).rejects.toThrow()
  expect(calls).toBe(1)
})

test("Retry-After dates and numeric values are interpreted correctly", () => {
  expect(retryDelay("2", 0)).toBe(2000)
  expect(retryDelay("Thu, 01 Jan 1970 00:00:10 GMT", 0, () => 0, 5000)).toBe(
    5000,
  )
  expect(retryDelay("garbage", 2, () => 0)).toBe(1000)
})
