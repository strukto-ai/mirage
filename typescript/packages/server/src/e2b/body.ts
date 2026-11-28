import { concat } from '@struktoai/mirage-core/utils/bytes'
import { RAW_BODIES } from '../constants.ts'
import { HttpError } from '../errors.ts'
import type { RouteRequest } from '../routes.ts'

export async function* bodyChunks(
  request: RouteRequest,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  signal.throwIfAborted()
  const { raw } = request
  if (!(raw instanceof ReadableStream)) throw new TypeError('E2B request body is not a web stream')
  const reader = (raw as ReadableStream<Uint8Array>).getReader()
  const cancel = (): void => {
    reader.cancel(signal.reason).catch((error: unknown) => {
      console.debug('sandbox request body cancel failed', error)
    })
  }
  signal.addEventListener('abort', cancel, { once: true })
  let ended = false
  try {
    for (;;) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) {
        ended = true
        return
      }
      yield chunk.value
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    if (ended) reader.releaseLock()
    else cancel()
  }
}

export async function readBody(
  request: RouteRequest,
  signal: AbortSignal,
  limit: number,
  limitMessage = 'request body too large',
): Promise<Uint8Array> {
  if (Number(request.headers['content-length']) > limit) {
    throw new HttpError('too_large', limitMessage)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of bodyChunks(request, signal)) {
    size += chunk.byteLength
    if (size > limit) throw new HttpError('too_large', limitMessage)
    chunks.push(chunk)
  }
  return concat(chunks)
}

export function unaryContentType(request: RouteRequest, streamMedia: string): string {
  const media = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (media === streamMedia || RAW_BODIES.test(media)) {
    throw new HttpError('invalid_request', 'expected JSON on a unary E2B route')
  }
  return media
}

export async function readJsonBody(
  request: RouteRequest,
  signal: AbortSignal,
  limit: number,
): Promise<unknown> {
  return parseJson(await readBody(request, signal, limit))
}

/** A JSON body, refusing a key that would reach an object's prototype; none when empty. */
export function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return undefined
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    const pending = [value]
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (typeof node !== 'object' || node === null) continue
      const constructor: unknown = Object.hasOwn(node, 'constructor') ? node.constructor : null
      if (
        Object.hasOwn(node, '__proto__') ||
        (typeof constructor === 'object' &&
          constructor !== null &&
          Object.hasOwn(constructor, 'prototype'))
      ) {
        throw new SyntaxError('forbidden prototype property')
      }
      for (const child of Object.values(node)) {
        if (typeof child === 'object' && child !== null) pending.push(child)
      }
    }
    return value
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new HttpError('invalid_json', 'body must be JSON', { cause: error })
  }
}
