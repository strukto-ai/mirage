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

import type { QdrantClient } from '@qdrant/js-client-rest'
import { describe, expect, it, vi } from 'vitest'

import { QdrantAccessor } from '../../accessor/qdrant.ts'
import { resolveQdrantConfig } from '../../vfs/qdrant/config.ts'
import { NAME_MAX_BYTES, byteLength } from '../../utils/sanitize.ts'
import { groupName } from './naming.ts'
import {
  buildFilter,
  candidateIds,
  condition,
  distinctValues,
  exactNameTest,
  jsonScalar,
  pointToRow,
  resolveGroup,
  rowsMatching,
  searchRows,
  valuePrefixTest,
} from './query.ts'
import type { QdrantPoint } from './types.ts'

describe('qdrant query helpers', () => {
  it('matches a plain segment as the string alone', () => {
    expect(condition('k', 'cat')).toEqual({ key: 'k', match: { value: 'cat' } })
  })

  it('adds the typed scalar a segment also spells', () => {
    // The listing renders a boolean or a number as compact JSON, so the
    // segment matches the string and the typed payload both; a number is
    // a closed range so integer and float payloads alike answer.
    expect(condition('k', 'true')).toEqual({
      should: [
        { key: 'k', match: { value: 'true' } },
        { key: 'k', match: { value: true } },
      ],
    })
    expect(condition('k', '12')).toEqual({
      should: [
        { key: 'k', match: { value: '12' } },
        { key: 'k', range: { gte: 12, lte: 12 } },
      ],
    })
    expect(condition('k', '1.5')).toEqual({
      should: [
        { key: 'k', match: { value: '1.5' } },
        { key: 'k', range: { gte: 1.5, lte: 1.5 } },
      ],
    })
  })

  it('keeps a spelling no value renders as a string', () => {
    for (const text of ['007', '05', '-0', '1.50', '1e5', 'NaN', 'null']) {
      expect(jsonScalar(text)).toBeNull()
      expect(condition('k', text)).toEqual({ key: 'k', match: { value: text } })
    }
  })

  it('builds a must filter, undefined when empty', () => {
    expect(buildFilter({})).toBeUndefined()
    expect(buildFilter({ label: 'cat', n: '2' })).toEqual({
      must: [
        { key: 'label', match: { value: 'cat' } },
        {
          should: [
            { key: 'n', match: { value: '2' } },
            { key: 'n', range: { gte: 2, lte: 2 } },
          ],
        },
      ],
    })
  })

  it.each(['id', '__proto__'])('maps a point to a row keyed by %s', (idField) => {
    const row = pointToRow({ id: 7, payload: { label: 'cat' } }, idField)
    expect(Object.hasOwn(row, idField)).toBe(true)
    expect(row).toEqual({ label: 'cat', [idField]: 7 })
  })

  it('matches a rendered basename rather than the source prefix', () => {
    const keep = valuePrefixTest('metadata.source', 'report-', true)
    expect(keep({ id: 1, payload: { metadata: { source: 's3://archive/report-late.pdf' } } })).toBe(
      true,
    )
    expect(keep({ id: 2, payload: { metadata: { source: 's3://archive/notes.pdf' } } })).toBe(false)
  })

  it('keeps one point per raw value that renders as the name', () => {
    const seen = new Set<string>()
    const keep = exactNameTest('metadata.source', 'report.pdf', true, seen)
    expect(keep({ id: 1, payload: { metadata: { source: 's3://one/report.pdf' } } })).toBe(true)
    expect(keep({ id: 2, payload: { metadata: { source: 's3://one/report.pdf' } } })).toBe(false)
    expect(keep({ id: 3, payload: { metadata: { source: 's3://one/notes.pdf' } } })).toBe(false)
    expect(keep({ id: 4, payload: { metadata: { source: 's3://two/report.pdf' } } })).toBe(true)
    expect([...seen]).toEqual(['s3://one/report.pdf', 's3://two/report.pdf'])
  })

  it('produces id candidates by type, none for invalid ids', () => {
    expect(candidateIds('7')).toEqual([7])
    const uid = '11111111-1111-1111-1111-111111111111'
    expect(candidateIds(uid)).toEqual([uid])
    expect(candidateIds('__nf_missing__')).toEqual([])
  })
})

describe('qdrant group values spell as their JSON', () => {
  it('keeps a boolean payload behind the segment its JSON spells', () => {
    // Python's `str(True)` and `String(true)` disagree, so both sides spell
    // a non-string value as compact JSON before comparing it to a segment.
    const seen = new Set<string>()
    const keep = exactNameTest('flag', 'true', false, seen)
    expect(keep({ id: 1, payload: { flag: true } })).toBe(true)
    expect([...seen]).toEqual(['true'])
  })
})

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

function withClient(acc: QdrantAccessor, client: unknown): QdrantAccessor {
  vi.spyOn(acc, 'client').mockResolvedValue(client as QdrantClient)
  return acc
}

function accessorWith(client: unknown): QdrantAccessor {
  return withClient(
    new QdrantAccessor(
      resolveQdrantConfig({ url: 'http://x', collection: 'c', groupBy: ['code'], idField: 'id' }),
    ),
    client,
  )
}

describe('qdrant query index auto-create', () => {
  it('creates index on index-required error then retries', async () => {
    const counts = { filtered: 0, indexed: 0 }
    const acc = accessorWith(fakeClient(counts))

    const rows = await rowsMatching(acc, 'c', { code: '100' }, 100)

    expect(rows.map((r) => r.id)).toEqual([10])
    expect(counts.filtered).toBe(1)
    expect(counts.indexed).toBe(1)
  })

  it('does not re-create indexes on subsequent calls', async () => {
    const counts = { filtered: 0, indexed: 0 }
    const acc = accessorWith(fakeClient(counts))

    await distinctValues(acc, 'c', 'code', { code: '100' }, 100)
    await distinctValues(acc, 'c', 'code', { code: '100' }, 100)

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

    await expect(rowsMatching(acc, 'c', { code: '100' }, 100)).rejects.toThrow('boom')
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
  return withClient(
    new QdrantAccessor(
      resolveQdrantConfig({ url: 'http://x', collection: 'c', idField: 'id', maxRows: CAP }),
    ),
    client,
  )
}

describe('qdrant query prefix scroll', () => {
  it('bounds the scroll by matches, paging past the cap', async () => {
    // Qdrant has no prefix condition for a point id, so the only way to reach
    // a row past the cap is to keep paging and test each page here. Matches
    // 45 and 450..453 straddle the first page boundary.
    const state = { pages: 0 }
    const rows = await rowsMatching(wideAccessor(pagingClient(state)), 'c', {}, CAP, '45')

    expect(rows.map((r) => r.id)).toEqual([45, 450, 451, 452, 453])
    expect(state.pages).toBeGreaterThan(1)
  })

  it('bounds the scroll by points when no prefix is given', async () => {
    const state = { pages: 0 }
    const rows = await rowsMatching(wideAccessor(pagingClient(state)), 'c', {}, CAP)

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

describe('qdrant query group resolution', () => {
  it('scans past the row cap for a second source behind one basename', async () => {
    // The first source alone fills the cap many times over, so a scroll bounded
    // by matching points would never see the second one.
    const state = { pages: 0 }
    const acc = wideAccessor(pagingClient(state, sharedBasename(WIDE)))

    const sources = await resolveGroup(acc, 'c', 'source', {}, 'report.pdf', true)

    expect(sources).toEqual(['s3://one/report.pdf', 's3://two/report.pdf'])
    expect(state.pages).toBeGreaterThan(1)
  })

  it('stops at the second distinct source', async () => {
    const state = { pages: 0 }
    const acc = wideAccessor(pagingClient(state, sharedBasename(2)))

    const sources = await resolveGroup(acc, 'c', 'source', {}, 'report.pdf', true)

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

    await expect(resolveGroup(acc, 'c', 'source', {}, name, true)).resolves.toEqual([sourceA])
  })

  it('answers nothing for a basename no source renders as', async () => {
    const state = { pages: 0 }
    const acc = wideAccessor(pagingClient(state, sharedBasename(WIDE)))

    await expect(resolveGroup(acc, 'c', 'source', {}, 'notes.pdf', true)).resolves.toEqual([])
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

describe('qdrant query search', () => {
  const embed = (text: string): Promise<number[]> => Promise.resolve([text.length, 0.5])

  it.each([
    ['the caller-supplied vector', { embed }, [3, 0.5]],
    [
      'the text, for the cluster to embed',
      { cloudInference: true },
      { text: 'dog', model: 'sentence-transformers/all-MiniLM-L6-v2' },
    ],
  ] as const)('sends %s', async (_name, extra, query) => {
    const seen: QueryOpts[] = []
    const acc = withClient(
      new QdrantAccessor(
        resolveQdrantConfig({ url: 'http://x', collection: 'c', idField: 'id', ...extra }),
      ),
      queryClient(seen),
    )
    const rows = await searchRows(acc, 'c', 'dog', 3)
    expect(seen).toEqual([{ query, limit: 3, with_payload: true }])
    expect(rows).toEqual([{ id: 1, name: 'alpha', _score: 0.9 }])
  })

  it('refuses a query nothing can vectorize', async () => {
    const seen: QueryOpts[] = []
    await expect(searchRows(accessorWith(queryClient(seen)), 'c', 'dog', 3)).rejects.toThrow(
      /pass embed, or set cloud_inference/,
    )
    expect(seen).toEqual([])
  })
})
