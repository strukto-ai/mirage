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

import { FORMAT, PARAM } from './transport.ts'

/**
 * The service worker a page without shared memory registers so pyodide's
 * worker can make its file calls. It holds the worker's synchronous
 * request until the host posts the answer under the same id, whichever
 * arrives first; every other request passes through untouched. It claims
 * the page when it activates, and again when the page asks (a hard reload
 * leaves a page uncontrolled). An update waits until no page uses the
 * version it replaces: a call that version holds would never meet an
 * answer the page posts to its successor.
 */
export const SCRIPT = `const PARAM = ${JSON.stringify(PARAM)}
const FORMAT = ${JSON.stringify(FORMAT)}
const answers = new Map()

function slot(id) {
  let entry = answers.get(id)
  if (entry === undefined) {
    let settle
    const answer = new Promise((resolve) => {
      settle = resolve
    })
    entry = { answer, settle }
    answers.set(id, entry)
  }
  return entry
}

self.addEventListener('install', () => {
  if (self.registration.active === null) self.skipWaiting()
})
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
self.addEventListener('message', (event) => {
  if (event.data === 'claim') event.waitUntil(self.clients.claim())
})
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  const op = url.searchParams.get(PARAM)
  const id = url.searchParams.get('id') ?? ''
  if (op === 'ping') {
    event.respondWith(new Response(null, { status: 204, headers: { [FORMAT]: '' } }))
  } else if (op === 'answer') {
    event.respondWith(
      event.request.arrayBuffer().then((body) => {
        slot(id).settle({ body, format: event.request.headers.get(FORMAT) ?? '' })
        return new Response(null, { status: 204, headers: { [FORMAT]: '' } })
      }),
    )
  } else if (op === 'wait') {
    event.respondWith(
      slot(id).answer.then(({ body, format }) => {
        answers.delete(id)
        return new Response(body, { headers: { [FORMAT]: format } })
      }),
    )
  }
})
`
