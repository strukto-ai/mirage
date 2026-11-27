import { abortable } from '@struktoai/mirage-core/utils/abort'
import { concat } from '@struktoai/mirage-core/utils/bytes'
import { RAW_BODIES } from '../constants.ts'
import { HttpError } from '../errors.ts'
import type { RouteReply, RouteRequest } from '../routes.ts'

/** Node's request stream, told apart from a web body without loading `node:stream`. */
interface NodeBody extends AsyncIterable<Uint8Array> {
  readonly readableEnded: boolean
  iterator(options: { destroyOnReturn: boolean }): AsyncIterator<Uint8Array>
}

function isNodeBody(raw: AsyncIterable<Uint8Array>): raw is NodeBody {
  return 'readableEnded' in raw && 'iterator' in raw && typeof raw.iterator === 'function'
}

export async function* bodyChunks(
  request: RouteRequest,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  signal.throwIfAborted()
  const { raw } = request
  const source: AsyncIterator<Uint8Array> = isNodeBody(raw)
    ? raw.iterator({ destroyOnReturn: false })
    : raw[Symbol.asyncIterator]()
  try {
    for (;;) {
      const chunk = await abortable(source.next(), signal)
      if (chunk.done === true) return
      yield chunk.value
    }
  } catch (error) {
    signal.throwIfAborted()
    throw error
  } finally {
    // A pending read unwinds when the response closes the connection.
    void source.return?.().catch((error: unknown) => {
      console.debug('sandbox request body closed', error)
    })
  }
}

export function closeUnreadBody(request: RouteRequest, reply: RouteReply): void {
  if (isNodeBody(request.raw) && !request.raw.readableEnded) {
    reply.header('connection', 'close')
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
