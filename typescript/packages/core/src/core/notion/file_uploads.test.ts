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
import { HttpNotionTransport } from './client.ts'
import { sendFilePart } from './file_uploads.ts'

describe('sendFilePart', () => {
  it('sends a rate-limited part again unchanged', async () => {
    const bodies: FormData[] = []
    const transport = new HttpNotionTransport({ apiKey: 'k', baseUrl: 'http://mock/v1' })
    const fakeFetch = (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      bodies.push(init?.body as FormData)
      return Promise.resolve(
        bodies.length === 1
          ? new Response('{"message":"slow"}', { status: 429, headers: { 'Retry-After': '0' } })
          : new Response('{"id":"up-1"}', { status: 200 }),
      )
    }
    ;(transport as unknown as { fetch: typeof fetch }).fetch = fakeFetch as typeof fetch

    const data = new Uint8Array([120, 0, 121])
    const result = await sendFilePart(transport, 'up-1', 'a b.txt', 'text/plain', data, 3)

    expect(result).toEqual({ id: 'up-1' })
    expect(bodies).toHaveLength(2)
    const sent = bodies[1]
    const file = sent?.get('file') as File
    expect(file.name).toBe('a b.txt')
    expect(file.type).toBe('text/plain')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(data)
    expect(sent?.get('part_number')).toBe('3')
  })
})
