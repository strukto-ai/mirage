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

import { networkBound, networkLets, networkRoute } from '@struktoai/mirage-core/io/network'

// The schemes that reach a host; data:, blob: and the like never leave the page.
export const REACHING = new Set(['http:', 'https:', 'ws:', 'wss:'])

let watching = false

/** The port a URL reaches, which it leaves unwritten for its scheme's own. */
export function portOf(target: URL): number {
  if (target.port !== '') return Number(target.port)
  return target.protocol === 'https:' || target.protocol === 'wss:' ? 443 : 80
}

function lets(url: string | URL): boolean {
  const target = new URL(url, globalThis.location.href)
  return !REACHING.has(target.protocol) || networkLets(target.hostname, '', portOf(target))
}

/**
 * `input` sent where the bound rule routes its host and port instead, and
 * judged there; as it is when it routes nowhere.
 */
export function routed(input: RequestInfo | URL): RequestInfo | URL {
  const target = new URL(input instanceof Request ? input.url : input, globalThis.location.href)
  if (!REACHING.has(target.protocol)) return input
  const route = networkRoute(target.hostname, portOf(target))
  if (route === null) return input
  target.hostname = route[0].includes(':') ? `[${route[0]}]` : route[0]
  target.port = String(route[1])
  return input instanceof Request ? new Request(target, input) : target
}

/**
 * Start judging every request the page makes, once: fetch and WebSocket ask
 * every live workspace's rule by host name, since a page resolves no
 * address and cannot tell one task's binding from another's, so the
 * strictest rule wins. A page cannot see where a redirect goes before it
 * follows one, so under a rule fetch follows none: a request that asked to
 * follow fails as fetch does. Called as the first workspace with a rule is
 * built. Mirrors Python's `watch_network`.
 */
export function watchNetwork(): void {
  if (watching) return
  watching = true
  const send = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input, init) => {
    if (networkBound() === null) return send(input, init)
    input = routed(input)
    if (!lets(input instanceof Request ? input.url : input)) throw new TypeError('Failed to fetch')
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow')
    if (redirect !== 'follow') return send(input, init)
    const response = await send(input, { ...init, redirect: 'manual' })
    if (response.type === 'opaqueredirect') throw new TypeError('Failed to fetch')
    return response
  }
  const Socket = globalThis.WebSocket
  globalThis.WebSocket = class extends Socket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const target = networkBound() === null ? url : (routed(url) as string | URL)
      if (networkBound() !== null && !lets(target)) {
        throw new DOMException(`The network rule refuses ${String(target)}`, 'SecurityError')
      }
      super(target, protocols)
    }
  }
}
