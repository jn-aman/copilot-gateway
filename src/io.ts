import { GatewayError } from "~/errors"
import { withSignal } from "~/lifecycle"

export async function readJson(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal,
  upstream = false,
): Promise<unknown> {
  const value = await readText(body, maximum, signal, upstream)
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw invalidBody(upstream)
  }
}

function invalidBody(upstream: boolean) {
  return new GatewayError(
    upstream ? 502 : 400,
    upstream ? "api_error" : "invalid_request_error",
    upstream
      ? "Invalid upstream JSON response"
      : "Request body must be valid JSON",
  )
}

export async function readText(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal,
  upstream = false,
): Promise<string> {
  const invalid = () => invalidBody(upstream)
  if (!body) throw invalid()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { value, done } = await withSignal(reader.read(), signal)
      if (done) break
      bytes += value.byteLength
      if (bytes > maximum)
        throw new GatewayError(
          upstream ? 502 : 413,
          upstream ? "api_error" : "invalid_request_error",
          upstream
            ? "Upstream response exceeded size limit"
            : "Request body exceeded size limit",
        )
      chunks.push(value)
    }
    const joined = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(joined)
    } catch {
      throw invalid()
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maximum = 1048576,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let buffer = ""
  let data: string[] = []
  let eventSize = 0
  try {
    while (true) {
      const { done, value } = await withSignal(reader.read(), signal)
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.search(/[\r\n]/)) !== -1) {
        // Keep a trailing CR until the next chunk so a split CRLF is one
        // delimiter. SSE also permits bare CR and bare LF delimiters.
        if (!done && buffer[newline] === "\r" && newline === buffer.length - 1)
          break
        const line = buffer.slice(0, newline)
        const delimiterLength =
          buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1
        buffer = buffer.slice(newline + delimiterLength)
        eventSize += Buffer.byteLength(line, "utf8")
        if (eventSize > maximum)
          throw new GatewayError(
            502,
            "api_error",
            "Upstream stream event exceeded size limit",
          )
        if (!line) {
          if (data.length) yield data.join("\n")
          data = []
          eventSize = 0
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""))
        }
      }
      if (eventSize + Buffer.byteLength(buffer, "utf8") > maximum)
        throw new GatewayError(
          502,
          "api_error",
          "Upstream stream event exceeded size limit",
        )
      if (done) {
        if (buffer || data.length)
          throw new GatewayError(
            502,
            "api_error",
            "Upstream stream ended within an event",
          )
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function encodeEvent(data: unknown, event?: string): Uint8Array {
  return new TextEncoder().encode(
    `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
  )
}
