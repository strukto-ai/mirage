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

import { type Egress, liveEgress } from '../gateway.ts'
import { type NetworkSetting, networkBound, networkLets, networkRoute } from '../network.ts'

// The schemes that reach a host; data:, blob: and the like never leave the page.
export const REACHING = new Set(['http:', 'https:', 'ws:', 'wss:'])

let watching = false

/** The port a URL reaches, which it leaves unwritten for its scheme's own. */
export function portOf(target: URL): number {
  if (target.port !== '') return Number(target.port)
  return target.protocol === 'https:' || target.protocol === 'wss:' ? 443 : 80
}

/** A request's URL, resolved against the page where there is one; an edge isolate has none. */
export function targetOf(input: RequestInfo | URL): URL {
  const { location } = globalThis as { location?: { href: string } }
  return new URL(input instanceof Request ? input.url : input, location?.href)
}

function lets(url: string | URL): boolean {
  const target = targetOf(url)
  return !REACHING.has(target.protocol) || networkLets(target.hostname, '', portOf(target))
}

// The schemes whose TLS checks the URL's own host name.
const SECURE = new Set(['https:', 'wss:'])

// The statuses fetch follows, and the most hops it follows before it fails.
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20

// The headers that describe a body, dropped when a redirect turns a request into a GET.
const BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
]

const IPV4 = /^\d+\.\d+\.\d+\.\d+(?::\d+)?$/

/** Whether a `network` entry names an address or a range rather than a host. */
function namesAddress(entry: string): boolean {
  return (
    entry.startsWith('[') || entry.includes('/') || entry.split(':').length > 2 || IPV4.test(entry)
  )
}

/**
 * Refuse a `network` setting that denies an address or a range. A page or
 * an edge isolate sends a request by host name and never sees the address
 * it reaches, so such an entry could not refuse it; Node and Python judge
 * each connection's address. An allowed address lets only a request made
 * to that address, so it stays.
 */
export function refuseUnseenAddresses(setting: NetworkSetting | undefined): void {
  if (typeof setting !== 'object') return
  const unseen = (setting.denied_domains ?? []).filter(namesAddress)
  if (unseen.length > 0) {
    throw new Error(
      `network: this host never sees the address a host name reaches, so it cannot deny ` +
        `${unseen.join(', ')}; deny host names instead`,
    )
  }
}

/**
 * Where a page's request to `host` on `port` goes instead, null for nowhere
 * else. A page cannot tell one task's binding from another's, so every live
 * line and file op must route it alike, but for a file op of a session with
 * a live line, which goes as that line does (a file call inside a line binds
 * the workspace's own rule over the session's); throws when two do not.
 */
function routeOf(host: string, port: number): readonly [string, number] | null {
  const live = liveEgress()
  if (live.length === 0) return networkRoute(host, port)
  // Whether a line of the session `egress` runs for is live in its workspace.
  const lined = (egress: Egress): boolean =>
    egress.session !== null &&
    live.some(
      (line) => !line.op && line.session === egress.session && line.policies === egress.policies,
    )
  const answers = live
    .filter((egress) => !egress.op || !lined(egress))
    .map((egress) => egress.rule?.route(host, port) ?? null)
  const first = answers[0] ?? null
  if (answers.some((answer) => answer?.join(':') !== first?.join(':'))) {
    throw new Error(`network: live calls route ${host}:${String(port)} apart`)
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
  const target = targetOf(input)
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

/** `input` routed where the bound rule sends it; fails as fetch does when the rule refuses it. */
function judged(input: RequestInfo | URL): RequestInfo | URL {
  let to: RequestInfo | URL
  try {
    to = routed(input)
  } catch (err) {
    console.debug('network:', err)
    throw new TypeError('Failed to fetch')
  }
  if (!lets(to instanceof Request ? to.url : to)) throw new TypeError('Failed to fetch')
  return to
}

/**
 * The options fetch sends the hop after a `status` redirect from `from` to
 * `to` with: a 303, or a 301 or 302 to a POST, becomes a GET without a
 * body, and a hop to another origin drops the credentials. Null when the
 * body cannot be sent again, as fetch fails for a streamed one.
 */
function nextHop(
  request: RequestInfo | URL,
  init: RequestInit,
  status: number,
  from: URL,
  to: URL,
): RequestInit | null {
  const base = request instanceof Request ? request : null
  let method = (init.method ?? base?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers ?? base?.headers)
  let body = init.body ?? null
  if (
    (status === 303 && method !== 'HEAD') ||
    ((status === 301 || status === 302) && method === 'POST')
  ) {
    method = 'GET'
    body = null
    for (const name of BODY_HEADERS) headers.delete(name)
  } else if (body instanceof ReadableStream || (init.body === undefined && base?.body != null)) {
    return null
  }
  if (to.origin !== from.origin) headers.delete('authorization')
  return {
    ...init,
    method,
    headers,
    body,
    redirect: 'manual',
    signal: init.signal ?? base?.signal ?? null,
  }
}

/**
 * Start judging every request the host makes, once: fetch and WebSocket ask
 * every live workspace's rule by host name, since a page or an edge isolate
 * resolves no address and cannot tell one task's binding from another's, so
 * the strictest rule wins. Under a rule fetch follows a redirect hop by
 * hop, each hop routed and judged as the first. A page cannot see where a
 * redirect goes, so there a request that asked to follow fails as fetch
 * does. Called as the first workspace with a rule is built. Mirrors
 * Python's `watch_network`.
 */
export function watchNetwork(): void {
  if (watching) return
  watching = true
  const send = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input, init) => {
    if (networkBound() === null) return send(input, init)
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow')
    if (redirect !== 'follow') return send(judged(input), init)
    let request: RequestInfo | URL = input
    let options: RequestInit = { ...init, redirect: 'manual' }
    for (let hop = 0; ; hop++) {
      const response = await send(judged(request), options)
      if (response.type === 'opaqueredirect') throw new TypeError('Failed to fetch')
      const location = response.headers.get('location')
      if (!REDIRECTS.has(response.status) || location === null) return response
      const from = targetOf(request)
      const to = new URL(location, from)
      const next = hop < MAX_REDIRECTS ? nextHop(request, options, response.status, from, to) : null
      if (next === null) throw new TypeError('Failed to fetch')
      await response.body?.cancel()
      request = to
      options = next
    }
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
