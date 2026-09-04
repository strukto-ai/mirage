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

import type { QdrantAccessor } from '../../accessor/qdrant.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { resolveQdrantConfig } from '../../resource/qdrant/config.ts'
import { PathSpec } from '../../types.ts'
import type { QdrantRow } from './client.ts'
import { readdir } from './readdir.ts'
import { blobBytes, renderJson, renderText } from './render.ts'

const ROW: QdrantRow = {
  id: 1,
  label: 'cat',
  kind: 'big',
  name: 'a big orange cat',
  image_bytes: 'UE5HLTE=',
}

const config = resolveQdrantConfig({
  idField: 'id',
  groupBy: ['label', 'kind'],
  textField: 'name',
  blobField: 'image_bytes',
  blobExt: 'png',
  vectorField: 'vector',
})

function accessor(): QdrantAccessor {
  return {
    config,
    listTables: () => Promise.resolve(['animals']),
    tableExists: (name: string) => Promise.resolve(name === 'animals'),
    distinct: () => Promise.resolve(['big']),
    rowsMatching: () => Promise.resolve([ROW]),
  } as unknown as QdrantAccessor
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: virtual.replace(/^\//, '') })
}

describe('qdrant readdir sizes', () => {
  it('lists the row files of a leaf group', async () => {
    const out = await readdir(accessor(), spec('/animals/cat/big'), new RAMIndexCacheStore())
    expect(out).toEqual([
      '/animals/cat/big/1.json',
      '/animals/cat/big/1.txt',
      '/animals/cat/big/1.png',
    ])
  })

  it('seeds the exact rendered size of every row file', async () => {
    const idx = new RAMIndexCacheStore()
    await readdir(accessor(), spec('/animals/cat/big'), idx)
    const json = await idx.get('/animals/cat/big/1.json')
    expect(json.entry?.size).toBe(renderJson(ROW, config).byteLength)
    const txt = await idx.get('/animals/cat/big/1.txt')
    expect(txt.entry?.size).toBe(renderText(ROW, config).byteLength)
    const blob = await idx.get('/animals/cat/big/1.png')
    expect(blob.entry?.size).toBe(blobBytes(ROW.image_bytes).byteLength)
  })

  it('lists without an index when none is given', async () => {
    const out = await readdir(accessor(), spec('/animals/cat/big'))
    expect(out).toHaveLength(3)
  })

  it('keeps listing when a blob value cannot be sized', async () => {
    // An undecodable blob must leave that one size unknown, not fail the
    // whole directory listing.
    const broken = { ...ROW, image_bytes: 42 }
    const acc = {
      config,
      listTables: () => Promise.resolve(['animals']),
      tableExists: (name: string) => Promise.resolve(name === 'animals'),
      distinct: () => Promise.resolve(['big']),
      rowsMatching: () => Promise.resolve([broken]),
    } as unknown as QdrantAccessor
    const idx = new RAMIndexCacheStore()
    const out = await readdir(acc, spec('/animals/cat/big'), idx)
    expect(out).toHaveLength(3)
    const blob = await idx.get('/animals/cat/big/1.png')
    expect(blob.entry?.size).toBeNull()
    const json = await idx.get('/animals/cat/big/1.json')
    expect(json.entry?.size).toBe(renderJson(broken, config).byteLength)
  })
})

describe('qdrant document lineage', () => {
  const lineageConfig = resolveQdrantConfig({
    collection: 'docs',
    groupBy: ['metadata.source'],
    basenameFields: ['metadata.source'],
    nameField: 'metadata.page',
    textField: 'page_content',
  })
  const lineageRow: QdrantRow = {
    id: 17,
    page_content: 'Refunds are processed within 14 days',
    metadata: { source: 's3://docs/policies/refund-2026.pdf', page: '004' },
  }
  const lineageAccessor = {
    config: lineageConfig,
    tableExists: () => Promise.resolve(true),
    distinct: (
      _table: string,
      _column: string,
      filters: Record<string, string>,
    ): Promise<string[]> =>
      Promise.resolve(
        Object.keys(filters).length === 0
          ? ['s3://docs/policies/refund-2026.pdf']
          : ['s3://docs/policies/refund-2026.pdf'],
      ),
    rowsMatching: () => Promise.resolve([lineageRow]),
  } as unknown as QdrantAccessor

  it('lists a source basename then meaningful chunk files', async () => {
    await expect(readdir(lineageAccessor, spec('/'))).resolves.toEqual(['/refund-2026.pdf'])
    await expect(readdir(lineageAccessor, spec('/refund-2026.pdf'))).resolves.toEqual([
      '/refund-2026.pdf/004__17.json',
      '/refund-2026.pdf/004__17.txt',
    ])
  })
})

const CAP = 5
const WIDE = 40

function cappedAccessor(seen: { prefix: string | undefined }): QdrantAccessor {
  // The accessor stands in for the scroll: with a prefix the cap bounds the
  // MATCHES, so the fake filters first and slices second.
  const rows: QdrantRow[] = []
  for (let i = 0; i < WIDE; i += 1) rows.push({ id: `doc-${String(i).padStart(3, '0')}` })
  return {
    config: resolveQdrantConfig({
      idField: 'id',
      collection: 'wide',
      groupBy: ['label'],
      maxRows: CAP,
    }),
    listTables: () => Promise.resolve(['wide']),
    tableExists: (name: string) => Promise.resolve(name === 'wide'),
    distinct: () => Promise.resolve(['all']),
    rowsMatching: (_t: string, _f: unknown, _c: string[], limit: number, prefix: string) => {
      seen.prefix = prefix
      return Promise.resolve(rows.filter((r) => String(r.id).startsWith(prefix)).slice(0, limit))
    },
  } as unknown as QdrantAccessor
}

function globbed(virtual: string, pattern: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: virtual.replace(/^\//, ''),
    pattern,
  })
}

function ids(paths: string[]): string[] {
  return [...new Set(paths.map((p) => (p.split('/').pop() ?? '').split('.')[0] ?? ''))]
}

describe('qdrant readdir narrows a capped listing', () => {
  it('pushes a row glob prefix into the scroll', async () => {
    const seen: { prefix: string | undefined } = { prefix: undefined }
    const out = await readdir(
      cappedAccessor(seen),
      globbed('/all', 'doc-03*'),
      new RAMIndexCacheStore(),
    )
    expect(ids(out)).toEqual(['doc-030', 'doc-031', 'doc-032', 'doc-033', 'doc-034'])
    expect(seen.prefix).toBe('doc-03')
  })

  it('cuts the prefix at the suffix so a leaf glob cannot ask for a dot', async () => {
    const seen: { prefix: string | undefined } = { prefix: undefined }
    await readdir(cappedAccessor(seen), globbed('/all', 'doc-039.js*'), new RAMIndexCacheStore())
    expect(seen.prefix).toBe('doc-039')
  })

  it('sends no prefix for a glob with no literal head', async () => {
    const seen: { prefix: string | undefined } = { prefix: undefined }
    const out = await readdir(
      cappedAccessor(seen),
      globbed('/all', '*9.json'),
      new RAMIndexCacheStore(),
    )
    expect(ids(out)).toEqual(['doc-000', 'doc-001', 'doc-002', 'doc-003', 'doc-004'])
    expect(seen.prefix).toBe('')
  })

  it('passes a rendered basename prefix into the capped scan', async () => {
    const seen: { prefix?: string; basename?: boolean } = {}
    const acc = {
      config: resolveQdrantConfig({
        collection: 'wide',
        groupBy: ['source'],
        basenameFields: ['source'],
        maxRows: CAP,
      }),
      tableExists: () => Promise.resolve(true),
      distinct: (
        _table: string,
        _column: string,
        _filters: Record<string, string>,
        _limit: number,
        prefix: string,
        basename: boolean,
      ) => {
        seen.prefix = prefix
        seen.basename = basename
        const values = Array.from({ length: WIDE }, (_, i) => `s3://docs/other-${String(i)}.pdf`)
        values.push('s3://archive/target-late.pdf')
        return Promise.resolve(
          values.filter((value) => (value.split('/').pop() ?? '').startsWith(prefix)).slice(0, CAP),
        )
      },
    } as unknown as QdrantAccessor
    await expect(readdir(acc, globbed('/', 'target*'))).resolves.toEqual(['/target-late.pdf'])
    expect(seen).toEqual({ prefix: 'target', basename: true })
  })

  it('does not cache a narrowed listing as the directory', async () => {
    const seen: { prefix: string | undefined } = { prefix: undefined }
    const acc = cappedAccessor(seen)
    const idx = new RAMIndexCacheStore()
    await readdir(acc, globbed('/all', 'doc-03*'), idx)
    const listed = await idx.listDir('/all/')
    expect(listed.entries === undefined || listed.entries === null).toBe(true)
    const plain = await readdir(acc, spec('/all'), idx)
    expect(ids(plain)).toEqual(['doc-000', 'doc-001', 'doc-002', 'doc-003', 'doc-004'])
  })
})
