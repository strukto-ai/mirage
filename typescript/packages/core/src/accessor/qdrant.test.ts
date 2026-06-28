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

import { resolveQdrantConfig } from '../resource/qdrant/config.ts'
import { QdrantAccessor } from './qdrant.ts'

interface ScrollOpts {
  filter?: unknown
}

function indexRequiredError(): Error {
  const e = new Error('Bad Request') as Error & { status: number; data: unknown }
  e.status = 400
  e.data = { status: { error: 'Bad request: Index required but not found for "code"' } }
  return e
}

const ALL_POINTS = [
  { id: 10, payload: { code: '100', name: 'alpha' } },
  { id: 20, payload: { code: '200', name: 'beta' } },
]

function fakeClient(counts: { filtered: number; indexed: number }) {
  let indexCreated = false
  return {
    scroll(_collection: string, opts: ScrollOpts) {
      if (opts.filter !== undefined && !indexCreated) {
        counts.filtered += 1
        throw indexRequiredError()
      }
      const filter = opts.filter as
        | { must?: { key: string; match: { value: unknown } }[] }
        | undefined
      const must = filter?.must
      const pts = must
        ? ALL_POINTS.filter((p) =>
            must.every((c) => p.payload[c.key as keyof typeof p.payload] === String(c.match.value)),
          )
        : ALL_POINTS
      return Promise.resolve({ points: pts, next_page_offset: null })
    },
    createPayloadIndex(_collection: string, _opts: object) {
      counts.indexed += 1
      indexCreated = true
      return Promise.resolve()
    },
  }
}

function accessorWith(client: unknown): QdrantAccessor {
  const acc = new QdrantAccessor(
    resolveQdrantConfig({ url: 'http://x', collection: 'c', groupBy: ['code'], idField: 'id' }),
  )
  ;(acc as unknown as { client: unknown }).client = client
  return acc
}

describe('QdrantAccessor index auto-create', () => {
  it('creates index on index-required error then retries', async () => {
    const counts = { filtered: 0, indexed: 0 }
    const acc = accessorWith(fakeClient(counts))

    const rows = await acc.rowsMatching('c', { code: '100' }, [], 100)

    expect(rows.map((r) => r.id)).toEqual([10])
    expect(counts.filtered).toBe(1)
    expect(counts.indexed).toBe(1)
  })

  it('does not re-create indexes on subsequent calls', async () => {
    const counts = { filtered: 0, indexed: 0 }
    const acc = accessorWith(fakeClient(counts))

    await acc.distinct('c', 'code', { code: '100' }, 100)
    await acc.distinct('c', 'code', { code: '100' }, 100)

    expect(counts.indexed).toBe(1)
  })

  it('propagates non-index errors', async () => {
    const client = {
      createPayloadIndex(_c: string, _opts: object) {
        return Promise.resolve()
      },
      scroll(_c: string, opts: ScrollOpts) {
        if (opts.filter !== undefined) {
          const e = new Error('boom') as Error & { status: number }
          e.status = 500
          throw e
        }
        return Promise.resolve({ points: [], next_page_offset: null })
      },
    }
    const acc = accessorWith(client)

    await expect(acc.rowsMatching('c', { code: '100' }, [], 100)).rejects.toThrow('boom')
  })
})
