import { Readable } from 'node:stream'
import { abortable } from '@struktoai/mirage-core/utils/abort'
import type { RouteReply, RouteRequest } from '../routes.ts'

export async function* bodyChunks(
  request: RouteRequest,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  signal.throwIfAborted()
  const { raw } = request
  const source: AsyncIterator<Uint8Array> =
    raw instanceof Readable ? raw.iterator({ destroyOnReturn: false }) : raw[Symbol.asyncIterator]()
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
  if (request.raw instanceof Readable && !request.raw.readableEnded) {
    reply.header('connection', 'close')
  }
}
