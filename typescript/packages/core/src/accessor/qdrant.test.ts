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

import type { QdrantPoint } from '../core/qdrant/client.ts'
import { groupName } from '../core/qdrant/naming.ts'
import { resolveQdrantConfig } from '../vfs/qdrant/config.ts'
import { NAME_MAX_BYTES, byteLength } from '../utils/sanitize.ts'
import { QdrantAccessor } from './qdrant.ts'

interface ScrollOpts {
  filter?: unknown
}

interface Condition {
  key?: string
  match?: { value: unknown }
  range?: { gte: number; lte: number }
  must?: Condition[]
  should?: Condition[]
}

/** The server's reading of a filter: typed matches, numeric ranges. */
function holds(point: { payload: Record<string, unknown> }, condition: unknown): boolean {
  if (condition === undefined) return true
  const c = condition as Condition
  if (c.must !== undefined && !c.must.every((child) => holds(point, child))) return false
  if (c.should !== undefined && !c.should.some((child) => holds(point, child))) return false
  if (c.key === undefined) return true
  const value = point.payload[c.key]
  if (c.range !== undefined) {
    return typeof value === 'number' && c.range.gte <= value && value <= c.range.lte
  }
  return c.match !== undefined && value === c.match.value
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
      const pts = ALL_POINTS.filter((p) => holds(p, opts.filter))
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

const WIDE = 600
const CAP = 5

function widePoints(): { id: number; payload: { code: string; name: string } }[] {
  const points = []
  for (let i = 1; i <= WIDE; i += 1)
    points.push({ id: i, payload: { code: 'all', name: `n${String(i)}` } })
  return points
}

function pagingClient(state: { pages: number }, points: QdrantPoint[] = widePoints()) {
  return {
    scroll(_collection: string, opts: { limit: number; offset: number | null }) {
      state.pages += 1
      const start = opts.offset ?? 0
      const window = points.slice(start, start + opts.limit)
      const next = start + opts.limit < points.length ? start + opts.limit : null
      return Promise.resolve({ points: window, next_page_offset: next })
    },
    createPayloadIndex(_collection: string, _opts: object) {
      return Promise.resolve()
    },
  }
}

function wideAccessor(client: unknown): QdrantAccessor {
  const acc = new QdrantAccessor(
    resolveQdrantConfig({ url: 'http://x', collection: 'c', idField: 'id', maxRows: CAP }),
  )
  ;(acc as unknown as { client: unknown }).client = client
  return acc
}

describe('QdrantAccessor prefix scroll', () => {
  it('bounds the scroll by matches, paging past the cap', async () => {
    // Qdrant has no prefix condition for a point id, so the only way to reach
    // a row past the cap is to keep paging and test each page here. Matches
    // 45 and 450..453 straddle the first page boundary.
    const state = { pages: 0 }
    const rows = await wideAccessor(pagingClient(state)).rowsMatching('c', {}, [], CAP, '45')

    expect(rows.map((r) => r.id)).toEqual([45, 450, 451, 452, 453])
    expect(state.pages).toBeGreaterThan(1)
  })

  it('bounds the scroll by points when no prefix is given', async () => {
    const state = { pages: 0 }
    const rows = await wideAccessor(pagingClient(state)).rowsMatching('c', {}, [], CAP)

    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5])
    expect(state.pages).toBe(1)
  })
})

function sharedBasename(secondAt: number): QdrantPoint[] {
  const points: QdrantPoint[] = []
  for (let i = 1; i <= WIDE; i += 1) {
    const source = i === secondAt ? 's3://two/report.pdf' : 's3://one/report.pdf'
    points.push({ id: i, payload: { source } })
  }
  return points
}

describe('QdrantAccessor group resolution', () => {
  it('scans past the row cap for a second source behind one basename', async () => {
    // The first source alone fills the cap many times over, so a scroll bounded
    // by matching points would never see the second one.
    const state = { pages: 0 }
    const acc = wideAccessor(pagingClient(state, sharedBasename(WIDE)))

    const sources = await acc.resolveGroup('c', 'source', {}, 'report.pdf', true)

    expect(sources).toEqual(['s3://one/report.pdf', 's3://two/report.pdf'])
    expect(state.pages).toBeGreaterThan(1)
  })

  it('stops at the second distinct source', async () => {
    const state = { pages: 0 }
    const acc = wideAccessor(pagingClient(state, sharedBasename(2)))

    const sources = await acc.resolveGroup('c', 'source', {}, 'report.pdf', true)

    expect(sources).toEqual(['s3://one/report.pdf', 's3://two/report.pdf'])
    expect(state.pages).toBe(1)
  })

  it('resolves a basename cut to NAME_MAX to the one leaf it stands for', async () => {
    // Two leaves that agree past NAME_MAX render as two directories that
    // fit the filesystem; the scan compares each candidate through the same
    // bounded rendering, so the cut name still opens exactly its own leaf.
    const state = { pages: 0 }
    const sourceA = `s3://docs/${'r'.repeat(300)}a.pdf`
    const sourceB = `s3://docs/${'r'.repeat(300)}b.pdf`
    const acc = wideAccessor(
      pagingClient(state, [
        { id: 1, payload: { source: sourceA } },
        { id: 2, payload: { source: sourceB } },
      ]),
    )
    const name = groupName(sourceA, true)
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)

    await expect(acc.resolveGroup('c', 'source', {}, name, true)).resolves.toEqual([sourceA])
  })

  it('answers nothing for a basename no source renders as', async () => {
    const state = { pages: 0 }
    const acc = wideAccessor(pagingClient(state, sharedBasename(WIDE)))

    await expect(acc.resolveGroup('c', 'source', {}, 'notes.pdf', true)).resolves.toEqual([])
  })
})

interface QueryOpts {
  query: unknown
  limit: number
  with_payload: boolean
}

function queryClient(seen: QueryOpts[]) {
  return {
    query(_collection: string, opts: QueryOpts) {
      seen.push(opts)
      return Promise.resolve({ points: [{ id: 1, payload: { name: 'alpha' }, score: 0.9 }] })
    },
  }
}

describe('QdrantAccessor search', () => {
  it('sends the caller-supplied vector when embed is configured', async () => {
    const seen: QueryOpts[] = []
    const embed = (text: string): Promise<number[]> => Promise.resolve([text.length, 0.5])
    const acc = new QdrantAccessor(
      resolveQdrantConfig({ url: 'http://x', collection: 'c', idField: 'id', embed }),
    )
    ;(acc as unknown as { client: unknown }).client = queryClient(seen)
    const rows = await acc.searchRows('c', 'dog', 3)
    expect(seen).toEqual([{ query: [3, 0.5], limit: 3, with_payload: true }])
    expect(rows).toEqual([{ id: 1, name: 'alpha', _score: 0.9 }])
  })

  it('asks the server to embed the text otherwise', async () => {
    const seen: QueryOpts[] = []
    const acc = accessorWith(queryClient(seen))
    await acc.searchRows('c', 'dog', 3)
    expect(seen).toEqual([
      {
        query: { text: 'dog', model: 'sentence-transformers/all-MiniLM-L6-v2' },
        limit: 3,
        with_payload: true,
      },
    ])
  })
})
