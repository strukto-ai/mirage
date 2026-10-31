// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { type IncomingMessage } from 'node:http'
import { MAX_REQUEST_PART, partEvents } from '../multipart.ts'
import type { Peeked } from './types.ts'

/** The workspace id a create names: its `id`, else its config's `workspace_id`. */
export function idOf(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString()) as {
      id?: unknown
      config?: { workspace_id?: unknown } | null
    }
    const id = parsed.id ?? parsed.config?.workspace_id
    return typeof id === 'string' ? id : undefined
  } catch (error) {
    // The worker refuses a body that is not JSON; it names no id here. Only
    // the error's name is logged: its message quotes the body's secrets.
    console.debug('mirage: a create body is not JSON:', (error as Error).name)
    return undefined
  }
}

/**
 * The chunks of `req` as they arrive. The request is paused between
 * chunks and keeps no listener, so what is left once the reader stops can
 * still be piped.
 */
async function* chunks(req: IncomingMessage): AsyncGenerator<Buffer> {
  for (;;) {
    if (req.readableEnded) return
    const chunk = await new Promise<Buffer | null>((resolve, reject) => {
      const settle = (): void => {
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('error', onError)
        req.pause()
      }
      const onData = (data: Buffer): void => {
        settle()
        resolve(data)
      }
      const onEnd = (): void => {
        settle()
        resolve(null)
      }
      const onError = (error: Error): void => {
        settle()
        reject(error)
      }
      req.on('data', onData)
      req.once('end', onEnd)
      req.once('error', onError)
      req.resume()
    })
    if (chunk === null) return
    yield chunk
  }
}

/**
 * Read a create's body, up to `MAX_REQUEST_PART`, until the workspace id
 * it names is known: a JSON body whole, or a multipart load's parts up to
 * the end of its `request` part. What was read is sent on first; past the
 * limit the id is not known.
 */
export async function peek(req: IncomingMessage): Promise<Peeked> {
  const type = req.headers['content-type'] ?? ''
  const read: Buffer[] = []
  let size = 0
  if (!type.startsWith('multipart/')) {
    for await (const chunk of chunks(req)) {
      read.push(chunk)
      size += chunk.byteLength
      if (size > MAX_REQUEST_PART) {
        return { head: Buffer.concat(read), more: true, id: undefined, lost: true, twice: false }
      }
    }
    const head = Buffer.concat(read)
    return { head, more: false, id: idOf(head), lost: false, twice: false }
  }
  let done = false
  const kept = async function* (): AsyncGenerator<Buffer> {
    for await (const chunk of chunks(req)) {
      read.push(chunk)
      size += chunk.byteLength
      yield chunk
      // Checked once the chunk is parsed: it may end the request part and
      // run past the limit, and bytes before the first part make no event.
      if (size > MAX_REQUEST_PART) return
    }
    done = true
  }
  const request: Buffer[] = []
  let name = ''
  let named = false
  let twice = false
  try {
    for await (const event of partEvents(kept(), type)) {
      // Read on to the next part, which must not be a second request.
      if (event.kind === 'begin') {
        if (name === 'request') {
          twice = event.name === 'request'
          break
        }
        name = event.name
      } else if (event.kind === 'data' && name === 'request') {
        request.push(Buffer.from(event.data))
      } else if (event.kind === 'end' && name === 'request') {
        named = true
      }
    }
  } catch (error) {
    // A malformed body goes on as it is, for the worker to refuse.
    console.debug('mirage: a load body did not parse:', error)
  }
  return {
    head: Buffer.concat(read),
    more: !done,
    id: idOf(Buffer.concat(request)),
    lost: !named && size > MAX_REQUEST_PART,
    twice,
  }
}
