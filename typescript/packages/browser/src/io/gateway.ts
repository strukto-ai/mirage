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
import { postNetworkGate, preNetworkGate } from '@struktoai/mirage-core/policy/policies'
import type { NetworkContext, NetworkEnd } from '@struktoai/mirage-core/policy/types'
import type { Limit } from '@struktoai/mirage-core/types'
import { REACHING, watchNetwork } from './network.ts'

let watching = false

// One live egress that let a request through: what to tell as it ends.
interface Ticket {
  readonly egress: Egress
  readonly ctx: NetworkContext
  readonly passed: readonly Policy[] | null
}

/**
 * The page's side of the gateway: each fetch a listening workspace's line
 * makes asks every live egress's preNetwork by host name, since a page
 * resolves no address and cannot tell one task's binding from another's;
 * its body is counted and cut past the tightest Limit; and postNetwork hears
 * how it ended. The counts are the body's bytes, since a page never sees the
 * wire. Mirrors Python's `_Gateway`.
 */
async function through(
  send: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const live = liveEgress()
  const answers = await Promise.all(live.map((egress) => egress.hooked))
  const hooked = live.filter((_, at) => answers[at] === true)
  const target = new URL(input instanceof Request ? input.url : input, globalThis.location.href)
  if (hooked.length === 0 || !REACHING.has(target.protocol)) return send(input, init)
  const host = target.hostname
  // A URL leaves its scheme's own port unwritten.
  const port =
    target.port !== ''
      ? Number(target.port)
      : target.protocol === 'https:' || target.protocol === 'wss:'
        ? 443
        : 80
  const started = Date.now()
  const body = init?.body
  const sent =
    typeof body === 'string'
      ? new TextEncoder().encode(body).byteLength
      : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
        ? body.byteLength
        : 0
  const tickets: Ticket[] = []
  // Tell every egress that let the request through how it went.
  const ended = async (how: NetworkEnd, sent: number, received: number): Promise<void> => {
    for (const { egress, ctx, passed } of tickets) {
      if (egress.policies === null) continue
      await postNetworkGate(
        egress.policies,
        {
          ...ctx,
          bytesSent: sent,
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
  for (const egress of hooked) {
    if (egress.policies === null) continue
    const ctx = opened(host, '', port)
    let answer: [readonly Policy[] | null, Limit | null]
    try {
      answer = await preNetworkGate(egress.policies, ctx)
    } catch {
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
  const stop = new AbortController()
  const timer =
    deadline === null
      ? null
      : setTimeout(() => {
          stop.abort()
        }, deadline * 1000)
  const signal = init?.signal == null ? stop.signal : AbortSignal.any([init.signal, stop.signal])
  let response: Response
  try {
    response = await send(input, { ...init, signal })
  } catch (err) {
    if (timer !== null) clearTimeout(timer)
    await ended(stop.signal.aborted ? 'limit' : 'error', sent, 0)
    throw err
  }
  if (response.body === null) {
    if (timer !== null) clearTimeout(timer)
    await ended('closed', sent, 0)
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
        await ended(stop.signal.aborted ? 'limit' : 'error', sent, received)
        controller.error(err)
        return
      }
      if (step.done) {
        if (timer !== null) clearTimeout(timer)
        await ended('closed', sent, received)
        controller.close()
        return
      }
      if (cap !== null && sent + received + step.value.byteLength > cap) {
        const left = Math.max(cap - sent - received, 0)
        received += left
        controller.enqueue(step.value.subarray(0, left))
        stop.abort()
        if (timer !== null) clearTimeout(timer)
        await reader.cancel().catch((err: unknown) => {
          console.debug('gateway: body cancel failed:', err)
        })
        await ended('limit', sent, received)
        controller.error(new TypeError('network error'))
        return
      }
      received += step.value.byteLength
      controller.enqueue(step.value)
    },
    async cancel(reason) {
      if (timer !== null) clearTimeout(timer)
      await reader.cancel(reason)
      await ended('closed', sent, received)
    },
  })
  return new Response(counted, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
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
