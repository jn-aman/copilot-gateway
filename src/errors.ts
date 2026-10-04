export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string,
    message: string,
    public readonly retryAfter?: string,
    public readonly body?: unknown,
    public readonly headers?: Headers,
  ) {
    super(message)
    this.name = "GatewayError"
  }
}

export function normalizeError(
  error: unknown,
  signal?: AbortSignal,
): GatewayError {
  if (signal?.aborted) {
    return signal.reason instanceof GatewayError
      ? signal.reason
      : new GatewayError(499, "request_cancelled", "Request cancelled")
  }
  return error instanceof GatewayError
    ? error
    : new GatewayError(500, "api_error", "An internal gateway error occurred")
}
