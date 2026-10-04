import { expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Fetcher } from "~/auth"

import {
  deviceLogin,
  readGithubToken,
  TokenManager,
  validateApiHost,
  writeGithubToken,
} from "~/auth"

test("token refresh is shared across simultaneous callers", async () => {
  let calls = 0
  const manager = new TokenManager(
    "github-secret",
    async () => {
      calls++
      await Bun.sleep(5)
      return Response.json({
        token: "copilot-secret",
        expires_at: 2000,
        refresh_in: 1000,
        endpoints: { api: "https://api.business.githubcopilot.com" },
      })
    },
    () => 1000000,
  )
  expect(
    await Promise.all(Array.from({ length: 20 }, () => manager.get())),
  ).toEqual(Array.from({ length: 20 }, () => "copilot-secret"))
  expect(calls).toBe(1)
  expect(manager.apiHost).toBe("https://api.business.githubcopilot.com")
})

test("failed proactive refresh retains only a still-valid credential and backs off", async () => {
  let now = 1000000
  let calls = 0
  const manager = new TokenManager(
    "github-secret",
    async () => {
      calls++
      if (calls > 1) return new Response(null, { status: 403 })
      return Response.json({
        token: "copilot-secret",
        expires_at: 1002,
        refresh_in: 2,
      })
    },
    () => now,
  )
  await manager.get()
  now += 1100
  expect(await manager.get()).toBe("copilot-secret")
  expect(await manager.get()).toBe("copilot-secret")
  expect(calls).toBe(2)
  now += 1000
  await expect(manager.get()).rejects.toThrow()
  expect(manager.ready).toBeFalse()
  expect(calls).toBe(2)
})

test("failed initial authentication does not hammer GitHub on subsequent requests", async () => {
  let calls = 0
  const manager = new TokenManager("github-secret", async () => {
    calls++
    return new Response(null, { status: 403 })
  })
  await expect(manager.get()).rejects.toThrow()
  await expect(manager.get()).rejects.toThrow()
  expect(calls).toBe(1)
})

test("stale unauthorized requests cannot invalidate a newer token", async () => {
  let calls = 0
  const manager = new TokenManager(
    "github-secret",
    async () =>
      Response.json({
        token: `token-${++calls}`,
        expires_at: 2000,
        refresh_in: 1000,
      }),
    () => 1000000,
  )
  const first = await manager.get()
  manager.invalidate(first)
  expect(await manager.get()).toBe("token-2")
  manager.invalidate(first)
  expect(await manager.get()).toBe("token-2")
  expect(calls).toBe(2)
})

test("short refresh intervals do not create zero-delay refresh loops", async () => {
  let calls = 0
  const manager = new TokenManager(
    "github-secret",
    async () => {
      calls++
      return Response.json({ token: "token", expires_at: 1002, refresh_in: 2 })
    },
    () => 1000000,
  )
  await manager.get()
  await manager.get()
  expect(calls).toBe(1)
})

test("credential endpoint hosts cannot send tokens to arbitrary origins", () => {
  for (const url of [
    "http://api.githubcopilot.com",
    "https://evil.example",
    "https://githubcopilot.com.evil.example",
    "https://api.githubcopilot.com@evil.example",
    "https://api.githubcopilot.com/path",
    "https://api.githubcopilot.com:8443",
    "https://api.githubcopilot.com?redirect=evil",
    "https://user:pass@api.githubcopilot.com",
  ]) {
    expect(() => validateApiHost(url)).toThrow()
  }
  expect(validateApiHost("https://api.enterprise.githubcopilot.com/")).toBe(
    "https://api.enterprise.githubcopilot.com",
  )
})

test("device polling handles pending, slowdown, success and the server interval", async () => {
  const replies = [
    {
      device_code: "device",
      user_code: "CODE",
      verification_uri: "https://github.com/login/device",
      expires_in: 60,
      interval: 5,
    },
    { error: "authorization_pending" },
    { error: "slow_down" },
    { access_token: "github-secret" },
  ]
  let now = 0
  const waits: number[] = []
  const fetcher: Fetcher = async () => Response.json(replies.shift())
  const token = await deviceLogin(
    (code, uri) => {
      expect(code).toBe("CODE")
      expect(uri).toBe("https://github.com/login/device")
    },
    new AbortController().signal,
    fetcher,
    async (ms) => {
      waits.push(ms)
      now += ms
    },
    () => now,
  )
  expect(token).toBe("github-secret")
  expect(waits).toEqual([5000, 5000, 10000])
})

test("device authorization denial terminates immediately", async () => {
  let calls = 0
  const fetcher: Fetcher = async () =>
    Response.json(
      ++calls === 1
        ? {
            device_code: "device",
            user_code: "CODE",
            verification_uri: "https://github.com/login/device",
            expires_in: 60,
            interval: 5,
          }
        : { error: "access_denied" },
    )
  await expect(
    deviceLogin(
      () => {},
      new AbortController().signal,
      fetcher,
      async () => {},
    ),
  ).rejects.toThrow("denied")
  expect(calls).toBe(2)
})

test("device authorization stops at expiry", async () => {
  let now = 0
  let calls = 0
  const fetcher: Fetcher = async () => {
    calls++
    return Response.json({
      device_code: "device",
      user_code: "CODE",
      verification_uri: "https://github.com/login/device",
      expires_in: 1,
      interval: 5,
    })
  }
  await expect(
    deviceLogin(
      () => {},
      new AbortController().signal,
      fetcher,
      async (ms) => {
        now += ms
      },
      () => now,
    ),
  ).rejects.toThrow("expired")
  expect(calls).toBe(1)
})

test("credentials are atomically persisted with owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-auth-test-"))
  try {
    const path = join(directory, "private", "github-token")
    await writeGithubToken(path, "github-secret")
    expect(await readGithubToken({}, path)).toBe("github-secret")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await writeGithubToken(path, "replacement")
    expect(await readGithubToken({}, path)).toBe("replacement")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
