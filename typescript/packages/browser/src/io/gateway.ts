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

import { type Egress, liveEgress, opened } from '@struktoai/mirage-core/io/gateway'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import {
  type Policies,
  postNetworkGate,
  preNetworkGate,
} from '@struktoai/mirage-core/policy/policies'
import type { NetworkContext, NetworkEnd } from '@struktoai/mirage-core/policy/types'
import type { Limit } from '@struktoai/mirage-core/types'
import { REACHING, portOf, routed, watchNetwork } from './network.ts'

let watching = false

// One live egress that let a request through: what to tell as it ends.
interface Ticket {
  readonly egress: Egress
  readonly ctx: NetworkContext
  readonly passed: readonly Policy[] | null
}

/**
 * The bytes a request body holds, null for a form or a stream, whose size a
 * page cannot know before it sends them.
 */
function measured(body: BodyInit | null | undefined): number | null {
  if (body === null || body === undefined) return 0
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength
  if (body instanceof Blob) return body.size
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength
  return null
}

/**
 * The page's side of the gateway: each fetch a listening workspace's line
 * makes asks every live workspace's preNetwork once, by host name, since a
 * page resolves no address and cannot tell one task's binding from
 * another's. Its body is counted and cut past the tightest Limit, an upload
 * past it, or of a size the page cannot know, is refused before it is sent,
 * and a redirect is refused, since a page cannot see where one goes before
 * following it. postNetwork hears how it ended, once. The counts are the
 * bodies' bytes, since a page never sees the wire. Mirrors Python's
 * `_Gateway`.
 */
async function through(
  send: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const live = liveEgress()
  const answers = await Promise.all(live.map((egress) => egress.hooked))
  // A nested call binds the same workspace's egress again: each workspace
  // judges a request once.
  const owners = new Map<Policies, Egress>()
  live.forEach((egress, at) => {
    if (answers[at] === true && egress.policies !== null) owners.set(egress.policies, egress)
  })
  try {
    input = routed(input)
  } catch (err) {
    console.debug('gateway:', err)
    throw new TypeError('Failed to fetch')
  }
  const target = new URL(input instanceof Request ? input.url : input, globalThis.location.href)
  if (owners.size === 0 || !REACHING.has(target.protocol)) return send(input, init)
  const host = target.hostname
  const port = portOf(target)
  const started = Date.now()
  const sent =
    init?.body !== undefined
      ? measured(init.body)
      : input instanceof Request && input.body !== null
        ? null
        : 0
  const tickets: Ticket[] = []
  let over = false
  // Tell every workspace that let the request through how it went, once.
  const ended = async (how: NetworkEnd, out: number, received: number): Promise<void> => {
    if (over) return
    over = true
    for (const { egress, ctx, passed } of tickets) {
      if (egress.policies === null) continue
      await postNetworkGate(
        egress.policies,
        {
          ...ctx,
          bytesSent: out,
          bytesReceived: received,
          seconds: (Date.now() - started) / 1000,
          ended: how,
        },
        passed,
      ).catch((err: unknown) => {
        console.debug('gateway: postNetwork failed:', err)
      })
    }
  }
  let cap: number | null = null
  let deadline: number | null = null
  for (const [policies, egress] of owners) {
    const ctx = opened(host, '', port)
    let answer: [readonly Policy[] | null, Limit | null]
    try {
      answer = await preNetworkGate(policies, ctx)
    } catch (err) {
      console.debug('gateway: preNetwork failed:', err)
      await ended('refused', 0, 0)
      throw new TypeError('Failed to fetch')
    }
    tickets.push({ egress, ctx, passed: answer[0] })
    const limit = answer[1]
    if (limit?.maxBytes != null) cap = Math.min(cap ?? limit.maxBytes, limit.maxBytes)
    if (limit?.timeoutSeconds != null) {
      deadline = Math.min(deadline ?? limit.timeoutSeconds, limit.timeoutSeconds)
    }
  }
  if (cap !== null && (sent === null || sent > cap)) {
    await ended('limit', 0, 0)
    throw new TypeError('Failed to fetch')
  }
  const stop = new AbortController()
  const timer =
    deadline === null
      ? null
      : setTimeout(() => {
          stop.abort()
        }, deadline * 1000)
  const asked = init?.signal ?? (input instanceof Request ? input.signal : null)
  const signal = asked == null ? stop.signal : AbortSignal.any([asked, stop.signal])
  // A redirect the page would follow goes where no policy saw, so it is not
  // followed; one the caller handles itself is handed back as fetch gives it.
  const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow')
  let response: Response
  try {
    response = await send(input, {
      ...init,
      signal,
      redirect: redirect === 'follow' ? 'manual' : redirect,
    })
  } catch (err) {
    if (timer !== null) clearTimeout(timer)
    await ended(stop.signal.aborted ? 'limit' : 'error', sent ?? 0, 0)
    throw err
  }
  if (response.type === 'opaqueredirect' && redirect === 'follow') {
    if (timer !== null) clearTimeout(timer)
    await ended('refused', sent ?? 0, 0)
    throw new TypeError('Failed to fetch')
  }
  if (response.body === null) {
    if (timer !== null) clearTimeout(timer)
    await ended('closed', sent ?? 0, 0)
    return response
  }
  let received = 0
  const reader = response.body.getReader()
  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let step: ReadableStreamReadResult<Uint8Array>
      try {
        step = await reader.read()
      } catch (err) {
        if (timer !== null) clearTimeout(timer)
        await ended(stop.signal.aborted ? 'limit' : 'error', sent ?? 0, received)
        controller.error(err)
        return
      }
      if (step.done) {
        if (timer !== null) clearTimeout(timer)
        await ended('closed', sent ?? 0, received)
        controller.close()
        return
      }
      if (cap !== null && (sent ?? 0) + received + step.value.byteLength > cap) {
        const left = Math.max(cap - (sent ?? 0) - received, 0)
        received += left
        controller.enqueue(step.value.subarray(0, left))
        stop.abort()
        if (timer !== null) clearTimeout(timer)
        await reader.cancel().catch((err: unknown) => {
          console.debug('gateway: body cancel failed:', err)
        })
        await ended('limit', sent ?? 0, received)
        controller.error(new TypeError('network error'))
        return
      }
      received += step.value.byteLength
      controller.enqueue(step.value)
    },
    async cancel(reason) {
      if (timer !== null) clearTimeout(timer)
      await reader.cancel(reason)
      await ended('closed', sent ?? 0, received)
    },
  })
  const relayed = new Response(counted, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  Object.defineProperties(relayed, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  })
  return relayed
}

/**
 * Send every request the page makes through `through`, once; one with no
 * listening egress goes on at once. A page cannot hold a WebSocket's
 * handshake for an async answer, so while a policy listens for connections a
 * WebSocket is refused. Mirrors Python's `_watch`.
 */
export function watch(): void {
  if (watching) return
  watching = true
  watchNetwork()
  const send = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (input, init) => through(send, input, init)
  const Socket = globalThis.WebSocket
  globalThis.WebSocket = class extends Socket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (liveEgress().some((egress) => egress.listening !== false && egress.policies !== null)) {
        throw new DOMException(
          `A policy listens for connections, so ${String(url)} is refused`,
          'SecurityError',
        )
      }
      super(url, protocols)
    }
  }
}
