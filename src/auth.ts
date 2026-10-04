import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"

import { GatewayError } from "~/errors"
import { readJson } from "~/io"
import { fetchWithRetry } from "~/retry"

export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>
const defaultFetch: Fetcher = (input, init) => fetch(input, init)
const clientId = "Iv1.b507a08c87ecfe98"
const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  expires_in: z.number().positive(),
  interval: z.number().positive(),
})
const oauthSchema = z.object({
  access_token: z.string().min(1).optional(),
  error: z.string().optional(),
  interval: z.number().positive().optional(),
})
const tokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.number().positive(),
  refresh_in: z.number().positive(),
  endpoints: z.object({ api: z.string().optional() }).optional(),
})

export function validateApiHost(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".githubcopilot.com") ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new GatewayError(
      502,
      "authentication_error",
      "Copilot returned an untrusted API endpoint",
    )
  }
  return url.origin
}

export async function githubJson(
  path: string,
  token: string,
  signal: AbortSignal,
  fetcher: Fetcher = defaultFetch,
): Promise<unknown> {
  const response = await fetchWithRetry(
    fetcher,
    `https://api.github.com${path}`,
    {
      headers: {
        authorization: `token ${token}`,
        accept: "application/json",
        "user-agent": "copilot-gateway",
        "editor-version": "vscode/1.115.0",
        "editor-plugin-version": "copilot-chat/0.44.0",
      },
      signal,
      redirect: "error",
    },
    { retries: 2, maxDelayMs: 5000 },
  )
  if (!response.ok) {
    await response.body?.cancel()
    throw new GatewayError(
      502,
      "authentication_error",
      `GitHub request failed (${response.status})`,
    )
  }
  try {
    return await readJson(response.body, 4194304, signal, true)
  } catch {
    throw new GatewayError(502, "api_error", "Invalid GitHub response")
  }
}

export async function readGithubToken(
  env: Record<string, string | undefined>,
  path: string,
): Promise<string> {
  if (env.GITHUB_TOKEN?.trim()) return env.GITHUB_TOKEN.trim()
  try {
    const token = (await readFile(path, "utf8")).trim()
    if (!token) throw new Error("Empty credential file")
    // Owner-only files mounted read-only in containers need no chmod.
    if (((await stat(path)).mode & 0o077) !== 0) await chmod(path, 0o600)
    return token
  } catch {
    throw new Error(
      "No GitHub credential available. Run bun run auth or set GITHUB_TOKEN.",
    )
  }
}

export async function writeGithubToken(
  path: string,
  token: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, token, { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function deviceLogin(
  announce: (code: string, uri: string) => void,
  signal: AbortSignal,
  fetcher: Fetcher = defaultFetch,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = waitFor,
  now = Date.now,
): Promise<string> {
  const post = async (path: string, body: Record<string, string>) => {
    const response = await fetcher(`https://github.com/login/${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      redirect: "error",
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new GatewayError(
        502,
        "authentication_error",
        `GitHub login failed (${response.status})`,
      )
    }
    return readJson(response.body, 1048576, signal, true)
  }
  const device = deviceSchema.parse(
    await post("device/code", { client_id: clientId, scope: "read:user" }),
  )
  announce(device.user_code, device.verification_uri)
  const expiresAt = now() + device.expires_in * 1000
  let interval = device.interval * 1000
  while (now() < expiresAt) {
    await wait(Math.min(interval, expiresAt - now()), signal)
    if (now() >= expiresAt) break
    const result = oauthSchema.parse(
      await post("oauth/access_token", {
        client_id: clientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    )
    if (result.access_token) return result.access_token
    if (result.error === "slow_down") {
      interval = Math.max(interval + 5000, (result.interval ?? 0) * 1000)
      continue
    }
    if (result.error === "authorization_pending") continue
    throw new GatewayError(
      401,
      "authentication_error",
      result.error === "access_denied"
        ? "GitHub authorization denied"
        : "GitHub authorization expired or failed",
    )
  }
  throw new GatewayError(
    401,
    "authentication_error",
    "GitHub device code expired; run auth again",
  )
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export class TokenManager {
  private current?: {
    token: string
    expiresAt: number
    refreshAt: number
    apiHost?: string
  }
  private pending?: Promise<string>
  private retryAt = 0
  private lastError?: unknown

  constructor(
    private readonly githubToken: string,
    private readonly fetcher: Fetcher = defaultFetch,
    private readonly now = Date.now,
  ) {}

  get ready(): boolean {
    return !!this.current && this.current.expiresAt > this.now()
  }
  get apiHost(): string | undefined {
    return this.current?.apiHost
  }
  invalidate(token: string) {
    if (this.current?.token === token) {
      this.current = undefined
      this.retryAt = 0
      this.lastError = undefined
    }
  }

  async get(): Promise<string> {
    if (
      this.githubToken.startsWith("ghp_") ||
      this.githubToken.startsWith("github_pat_")
    ) {
      throw new GatewayError(
        401,
        "authentication_error",
        "Copilot does not support personal access tokens. Run bun run auth to obtain a Copilot OAuth credential.",
      )
    }
    const now = this.now()
    if (
      this.current &&
      this.current.expiresAt > now &&
      (this.current.refreshAt > now || this.retryAt > now)
    )
      return this.current.token
    if (this.retryAt > now && this.lastError) throw this.lastError
    if (!this.pending) {
      this.pending = this.refresh()
        .catch((error: unknown) => {
          this.retryAt = this.now() + 5000
          this.lastError = error
          if (this.current && this.current.expiresAt > this.now())
            return this.current.token
          throw error
        })
        .finally(() => {
          this.pending = undefined
        })
    }
    return this.pending
  }

  private async refresh(): Promise<string> {
    const result = tokenSchema.safeParse(
      await githubJson(
        "/copilot_internal/v2/token",
        this.githubToken,
        AbortSignal.timeout(15000),
        this.fetcher,
      ),
    )
    if (!result.success || result.data.expires_at * 1000 <= this.now())
      throw new GatewayError(
        502,
        "authentication_error",
        "GitHub returned an invalid or expired Copilot credential",
      )
    const expiresAt = result.data.expires_at * 1000
    const lifetime = Math.min(
      result.data.refresh_in * 1000,
      expiresAt - this.now(),
    )
    const apiHost = result.data.endpoints?.api
      ? validateApiHost(result.data.endpoints.api)
      : undefined
    this.current = {
      token: result.data.token,
      expiresAt,
      apiHost,
      refreshAt:
        this.now() + Math.max(1, lifetime - Math.min(60000, lifetime / 2)),
    }
    this.retryAt = 0
    this.lastError = undefined
    return result.data.token
  }
}
