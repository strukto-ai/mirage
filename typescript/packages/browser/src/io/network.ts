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

import { type Egress, liveEgress } from '@struktoai/mirage-core/io/gateway'
import {
  type NetworkRule,
  networkBound,
  networkLets,
  networkRoute,
} from '@struktoai/mirage-core/io/network'
import type { Policies } from '@struktoai/mirage-core/policy/policies'

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

// The schemes whose TLS checks the URL's own host name.
const SECURE = new Set(['https:', 'wss:'])

/**
 * Where a page's request to `host` on `port` goes instead, null for nowhere
 * else. A page cannot tell one task's binding from another's, so every live
 * workspace must route it alike, each by its newest binding (a file call
 * inside a session's line binds the workspace's own rule over the
 * session's); throws when two do not.
 */
function routeOf(host: string, port: number): readonly [string, number] | null {
  const newest = new Map<Policies | NetworkRule | null, Egress>()
  for (const egress of liveEgress()) newest.set(egress.policies ?? egress.rule, egress)
  if (newest.size === 0) return networkRoute(host, port)
  const answers = [...newest.values()].map((egress) => egress.rule?.route(host, port) ?? null)
  const first = answers[0] ?? null
  if (answers.some((answer) => answer?.join(':') !== first?.join(':'))) {
    throw new Error(`network: live workspaces route ${host}:${String(port)} apart`)
  }
  return first
}

/**
 * `input` sent where the bound rule routes its host and port instead, and
 * judged there; as it is when it routes nowhere. A page checks TLS against
 * the URL it sends, so a secure route may change the port but not the host.
 * Throws when it cannot be routed.
 */
export function routed(input: RequestInfo | URL): RequestInfo | URL {
  const target = new URL(input instanceof Request ? input.url : input, globalThis.location.href)
  if (!REACHING.has(target.protocol)) return input
  const route = routeOf(target.hostname, portOf(target))
  if (route === null) return input
  const bare = target.hostname
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase()
  if (SECURE.has(target.protocol) && route[0] !== bare) {
    throw new Error(
      `network: a page cannot route ${target.host} to another host and still check its TLS name`,
    )
  }
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
    try {
      input = routed(input)
    } catch (err) {
      console.debug('network:', err)
      throw new TypeError('Failed to fetch')
    }
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
      let target = url
      if (networkBound() !== null) {
        try {
          target = routed(url) as string | URL
        } catch (err) {
          throw new DOMException(String(err), 'SecurityError')
        }
        if (!lets(target)) {
          throw new DOMException(`The network rule refuses ${String(target)}`, 'SecurityError')
        }
      }
      super(target, protocols)
    }
  }
}
