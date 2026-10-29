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

import { networkBound, networkLets } from '@struktoai/mirage-core/io/network'

// The schemes that reach a host; data:, blob: and the like never leave the page.
const REACHING = new Set(['http:', 'https:', 'ws:', 'wss:'])

let watching = false

function lets(url: string | URL): boolean {
  const target = new URL(url, globalThis.location.href)
  return !REACHING.has(target.protocol) || networkLets(target.hostname, '')
}

/**
 * Start judging every request the page makes, once: fetch and WebSocket ask
 * every live workspace's rule by host name, since a page resolves no
 * address and cannot tell one task's binding from another's, so the
 * strictest rule wins. Called as the first workspace with a rule is built.
 * Mirrors Python's `watch_network`.
 */
export function watchNetwork(): void {
  if (watching) return
  watching = true
  const send = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (input, init) => {
    if (networkBound() !== null && !lets(input instanceof Request ? input.url : input)) {
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    return send(input, init)
  }
  const Socket = globalThis.WebSocket
  globalThis.WebSocket = class extends Socket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (networkBound() !== null && !lets(url)) {
        throw new DOMException(`The network rule refuses ${String(url)}`, 'SecurityError')
      }
      super(url, protocols)
    }
  }
}
