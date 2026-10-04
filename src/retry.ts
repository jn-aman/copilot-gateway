import type { Fetcher } from "~/auth"

import { withSignal } from "~/lifecycle"

export interface RetryPolicy {
  retries: number
  maxDelayMs: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  onRetry?: () => void
}

export function retryDelay(
  header: string | null,
  attempt: number,
  random: () => number = Math.random,
  now = Date.now(),
): number {
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.max(0, date - now)
  }
  return Math.round((0.5 + random() / 2) * Math.min(10000, 500 * 2 ** attempt))
}

export async function sleepAbortable(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await withSignal(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      }),
      signal,
    )
  } finally {
    clearTimeout(timer)
  }
}

// A generation is retried only after an explicit rate-limit rejection. Network/5xx
// failures are ambiguous: the server may have already accepted billable work.
export async function fetchWithRetry(
  fetcher: Fetcher,
  url: string,
  init: RequestInit & { signal: AbortSignal },
  policy: RetryPolicy,
): Promise<Response> {
  const safe = !init.method || init.method === "GET"
  for (let attempt = 0; ; attempt++) {
    init.signal.throwIfAborted()
    let response: Response
    try {
      response = await fetcher(url, init)
    } catch (error) {
      if (!safe || init.signal.aborted || attempt >= policy.retries) throw error
      policy.onRetry?.()
      await (policy.sleep ?? sleepAbortable)(
        Math.min(policy.maxDelayMs, retryDelay(null, attempt, policy.random)),
        init.signal,
      )
      continue
    }
    const retryable =
      response.status === 429 ||
      (safe && [408, 502, 503, 504].includes(response.status))
    if (
      !retryable ||
      response.headers.get("x-should-retry") === "false" ||
      attempt >= policy.retries
    )
      return response
    const delay = retryDelay(
      response.headers.get("retry-after"),
      attempt,
      policy.random,
    )
    if (delay > policy.maxDelayMs) return response
    await response.body?.cancel()
    policy.onRetry?.()
    await (policy.sleep ?? sleepAbortable)(delay, init.signal)
  }
}
