import { GatewayError } from "~/errors"

export class Admission {
  private active = 0
  private nextAllowedAt = 0
  private draining = false

  constructor(
    private readonly maximum: number,
    private readonly intervalMs: number,
    private readonly now = Date.now,
  ) {}

  get snapshot() {
    return { active: this.active, draining: this.draining }
  }
  drain() {
    this.draining = true
  }

  acquire(): () => void {
    if (this.draining)
      throw new GatewayError(
        503,
        "overloaded_error",
        "Gateway is shutting down",
        "1",
      )
    if (this.active >= this.maximum)
      throw new GatewayError(
        429,
        "rate_limit_error",
        "Gateway concurrency limit reached",
        "1",
      )
    const now = this.now()
    if (now < this.nextAllowedAt) {
      throw new GatewayError(
        429,
        "rate_limit_error",
        "Gateway request interval reached",
        String(Math.max(1, Math.ceil((this.nextAllowedAt - now) / 1000))),
      )
    }
    this.nextAllowedAt = now + this.intervalMs
    this.active++
    let released = false
    return () => {
      if (!released) {
        released = true
        this.active--
      }
    }
  }
}

export function requestScope(clientSignal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(
    () =>
      controller.abort(
        new GatewayError(504, "timeout_error", "Upstream request timed out"),
      ),
    timeoutMs,
  )
  timer.unref()
  return {
    signal: AbortSignal.any([clientSignal, controller.signal]),
    abort: () =>
      controller.abort(
        new GatewayError(499, "request_cancelled", "Request cancelled"),
      ),
    dispose: () => clearTimeout(timer),
  }
}

export async function withSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}
