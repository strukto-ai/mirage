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

import { describe, expect, it } from 'vitest'
import { WebRoutes } from '../src/router.ts'

function routes(): WebRoutes {
  const app = new WebRoutes()
  app.post<{ Body: unknown }>('/echo', { bodyLimit: 8 }, (req) => ({ body: req.body }))
  app.put<{ Body: { path: string } }>(
    '/doc',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    (req) => req.body,
  )
  app.post('/upload', async (req) => {
    let size = 0
    for await (const chunk of req.raw) size += chunk.byteLength
    return { size }
  })
  app.get<{ Params: { id: string } }>('/items/:id', (req) => ({ id: req.params.id }))
  return app
}

function endless(): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode('"0123')
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk)
    },
  })
}

describe('WebRoutes', () => {
  it('refuses a body past the limit with no Content-Length before reading the rest', async () => {
    const response = await routes().fetch(
      new Request('http://edge.test/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: endless(),
        duplex: 'half',
      } as RequestInit),
      null,
    )
    expect(response.status).toBe(413)
  })

  it('ends an empty multipart upload', async () => {
    const response = await routes().fetch(
      new Request('http://edge.test/upload', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=x' },
      }),
      null,
    )
    expect(await response.json()).toEqual({ size: 0 })
  })

  it('hands an octet-stream body to its route unread', async () => {
    const response = await routes().fetch(
      new Request('http://edge.test/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'abc',
      }),
      null,
    )
    expect(await response.json()).toEqual({ size: 3 })
  })

  it('answers a malformed path escape with 400', async () => {
    const response = await routes().fetch(new Request('http://edge.test/items/%ZZ'), null)
    expect([response.status, await response.json()]).toEqual([
      400,
      { error: { code: 'invalid_request', message: 'path is not percent-encoded' } },
    ])
  })

  it('drops a field named after an Object.prototype member', async () => {
    const response = await routes().fetch(
      new Request('http://edge.test/doc', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/vfs.md', constructor: 0 }),
      }),
      null,
    )
    expect([response.status, await response.json()]).toEqual([200, { path: '/vfs.md' }])
  })
})
