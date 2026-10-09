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
import type { Evicted, IndexEntry, SetDirOptions } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { resolveQdrantConfig, type QdrantConfig } from '../../vfs/qdrant/config.ts'
import { PathSpec } from '../../types.ts'
import { blobBytes } from '../vector/read.ts'
import { fieldValue } from './payload.ts'
import { pointToRow } from './query.ts'
import { renderJson, renderText } from './render.ts'
import { readdir } from './tree.ts'
import type { QdrantPoint } from './types.ts'

interface Condition {
  key?: string
  match?: { value: unknown }
  range?: { gte: number; lte: number }
  must?: Condition[]
  should?: Condition[]
}

/** The server's reading of a filter: typed matches, numeric ranges. */
function holds(point: QdrantPoint, c: Condition | undefined): boolean {
  if (c === undefined) return true
  if (c.must !== undefined && !c.must.every((child) => holds(point, child))) return false
  if (c.should !== undefined && !c.should.some((child) => holds(point, child))) return false
  if (c.key === undefined) return true
  const value = fieldValue(point.payload ?? {}, c.key)
  if (c.range !== undefined) {
    return typeof value === 'number' && c.range.gte <= value && value <= c.range.lte
  }
  return c.match !== undefined && value === c.match.value
}

/** A collection served the way the scroll API pages it. */
function accessorOf(config: QdrantConfig, points: QdrantPoint[], collection = 'animals') {
  const client = {
    getCollections: () => Promise.resolve({ collections: [{ name: collection }] }),
    collectionExists: (name: string) => Promise.resolve({ exists: name === collection }),
    scroll: (_c: string, opts: { filter?: Condition; limit: number; offset: number | null }) => {
      const matched = points.filter((point) => holds(point, opts.filter))
      const start = opts.offset ?? 0
      const next = start + opts.limit < matched.length ? start + opts.limit : null
      return Promise.resolve({
        points: matched.slice(start, start + opts.limit),
        next_page_offset: next,
      })
    },
  }
  const accessor = new QdrantAccessor(resolveQdrantConfig(config))
  vi.spyOn(accessor, 'client').mockResolvedValue(client as unknown as QdrantClient)
  return accessor
}

const ANIMALS: QdrantConfig = {
  idField: 'id',
  groupBy: ['label', 'kind'],
  textField: 'name',
  blobField: 'image_bytes',
  blobExt: 'png',
  vectorField: 'vector',
}

const CAT: QdrantPoint = {
  id: 1,
  payload: { label: 'cat', kind: 'big', name: 'a big orange cat', image_bytes: 'UE5HLTE=' },
}

class WindowSpy extends RAMIndexCacheStore {
  readonly windows = new Map<string, boolean>()

  override setDir(
    vfsPath: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
    options: SetDirOptions = {},
  ): Promise<Evicted[]> {
    this.windows.set(vfsPath, options.window === true)
    return super.setDir(vfsPath, entries, expiredAt, options)
  }
}

function spec(virtual: string, pattern?: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: virtual.replace(/^\//, ''),
    ...(pattern !== undefined ? { pattern } : {}),
  })
}

function ids(paths: string[]): string[] {
  return [...new Set(paths.map((p) => (p.split('/').pop() ?? '').split('.')[0] ?? ''))]
}

describe('qdrant readdir sizes', () => {
  it('lists the row files of a leaf group, with or without an index', async () => {
    const files = ['/animals/cat/big/1.json', '/animals/cat/big/1.txt', '/animals/cat/big/1.png']
    const acc = accessorOf(ANIMALS, [CAT])
    await expect(readdir(acc, spec('/animals/cat/big'), new RAMIndexCacheStore())).resolves.toEqual(
      files,
    )
    await expect(readdir(acc, spec('/animals/cat/big'))).resolves.toEqual(files)
  })

  it('seeds the exact rendered size of every row file', async () => {
    const acc = accessorOf(ANIMALS, [CAT])
    const row = pointToRow(CAT, 'id')
    const idx = new RAMIndexCacheStore()
    await readdir(acc, spec('/animals/cat/big'), idx)
    const json = await idx.get('/animals/cat/big/1.json')
    expect(json.entry?.size).toBe(renderJson(row, acc.config).byteLength)
    const txt = await idx.get('/animals/cat/big/1.txt')
    expect(txt.entry?.size).toBe(renderText(row, acc.config).byteLength)
    const blob = await idx.get('/animals/cat/big/1.png')
    expect(blob.entry?.size).toBe(blobBytes(row.image_bytes).byteLength)
  })

  it('keeps listing when a blob value cannot be sized, and says why', async () => {
    // An undecodable blob must leave that one size unknown, not fail the
    // whole directory listing; the failure is logged rather than swallowed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken = { id: 1, payload: { ...CAT.payload, image_bytes: 42 } }
    const idx = new RAMIndexCacheStore()
    const out = await readdir(accessorOf(ANIMALS, [broken]), spec('/animals/cat/big'), idx)
    expect(out).toHaveLength(3)
    const blob = await idx.get('/animals/cat/big/1.png')
    expect(blob.entry?.size).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('qdrant document lineage', () => {
  const lineage: QdrantConfig = {
    collection: 'docs',
    groupBy: ['metadata.source'],
    basenameFields: ['metadata.source'],
    nameField: 'metadata.page',
    textField: 'page_content',
  }

  it('lists a source basename then meaningful chunk files', async () => {
    const acc = accessorOf(
      lineage,
      [
        {
          id: 17,
          payload: {
            page_content: 'Refunds are processed within 14 days',
            metadata: { source: 's3://docs/policies/refund-2026.pdf', page: '004' },
          },
        },
      ],
      'docs',
    )
    await expect(readdir(acc, spec('/'))).resolves.toEqual(['/refund-2026.pdf'])
    await expect(readdir(acc, spec('/refund-2026.pdf'))).resolves.toEqual([
      '/refund-2026.pdf/004__17.json',
      '/refund-2026.pdf/004__17.txt',
    ])
  })

  it('refuses a basename two sources render as', async () => {
    const acc = accessorOf(
      lineage,
      [
        { id: 1, payload: { metadata: { source: 's3://one/report.pdf' } } },
        { id: 2, payload: { metadata: { source: 's3://two/report.pdf' } } },
      ],
      'docs',
    )
    await expect(readdir(acc, spec('/report.pdf'))).rejects.toThrow('basename collision')
  })
})

const CAP = 5
const WIDE = 40

function cappedAccessor(): QdrantAccessor {
  const points: QdrantPoint[] = []
  for (let i = 0; i < WIDE; i += 1) {
    points.push({ id: `doc-${String(i).padStart(3, '0')}`, payload: { label: 'all' } })
  }
  return accessorOf(
    { idField: 'id', collection: 'wide', groupBy: ['label'], maxRows: CAP },
    points,
    'wide',
  )
}

describe('qdrant readdir narrows a capped listing', () => {
  it.each([
    ['doc-03*', ['doc-030', 'doc-031', 'doc-032', 'doc-033', 'doc-034']],
    // The prefix is cut at the suffix, so a leaf glob cannot ask for a dot.
    ['doc-039.js*', ['doc-039']],
    ['*9.json', ['doc-000', 'doc-001', 'doc-002', 'doc-003', 'doc-004']],
  ])('scrolls %s to the rows its literal head names', async (pattern, expected) => {
    const out = await readdir(cappedAccessor(), spec('/all', pattern), new RAMIndexCacheStore())
    expect(ids(out)).toEqual(expected)
  })

  it('reaches a rendered basename past the cap', async () => {
    const points: QdrantPoint[] = Array.from({ length: WIDE }, (_, i) => ({
      id: i + 1,
      payload: { source: `s3://docs/other-${String(i)}.pdf` },
    }))
    points.push({ id: WIDE + 1, payload: { source: 's3://archive/target-late.pdf' } })
    const acc = accessorOf(
      { collection: 'wide', groupBy: ['source'], basenameFields: ['source'], maxRows: CAP },
      points,
      'wide',
    )
    await expect(readdir(acc, spec('/', 'target*'))).resolves.toEqual(['/target-late.pdf'])
  })

  it('does not cache a narrowed listing as the directory', async () => {
    const acc = cappedAccessor()
    const idx = new RAMIndexCacheStore()
    await readdir(acc, spec('/all', 'doc-03*'), idx)
    const listed = await idx.listDir('/all/')
    expect(listed.entries === undefined || listed.entries === null).toBe(true)
    const plain = await readdir(acc, spec('/all'), idx)
    expect(ids(plain)).toEqual(['doc-000', 'doc-001', 'doc-002', 'doc-003', 'doc-004'])
  })
})

describe('qdrant blank and dot-led group values', () => {
  it('list with the escape lead and filter for their own value', async () => {
    // A blank value listed as `unknown` and then filtered for that word; a
    // dot-led one was dropped as hidden and refused as a path. Both carry
    // the escape lead, so each lists and filters for its own value.
    const acc = accessorOf({ collection: 'animals', groupBy: ['label'], textField: 'name' }, [
      { id: 1, payload: { label: '', name: 'blank' } },
      { id: 2, payload: { label: '.env', name: 'dotted' } },
    ])
    await expect(readdir(acc, spec('/'))).resolves.toEqual(['/⁄', '/⁄.env'])
    expect(ids(await readdir(acc, spec('/⁄')))).toEqual(['1'])
    expect(ids(await readdir(acc, spec('/⁄.env')))).toEqual(['2'])
  })
})

describe('qdrant capped listings', () => {
  it('writes groups and rows as windows', async () => {
    // Groups and rows are read up to maxRows, so a row outside the head of
    // the table is not gone because a listing no longer names it.
    const index = new WindowSpy()
    const acc = accessorOf(ANIMALS, [CAT])
    await readdir(acc, spec('/animals'), index)
    await readdir(acc, spec('/animals/cat/big'), index)
    expect(index.windows.get('/animals')).toBe(true)
    expect(index.windows.get('/animals/cat/big')).toBe(true)
  })
})
