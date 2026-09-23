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

import { describe, expect, it, vi } from 'vitest'

import { LanceDBAccessor } from '../../accessor/lancedb.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { resolveLanceDBConfig } from '../../vfs/lancedb/config.ts'
import { PathSpec } from '../../types.ts'
import type { LanceDriver, LanceRow } from './_driver.ts'
import { readdir } from './readdir.ts'
import { renderCard } from './render.ts'

const ROW: LanceRow = {
  id: 1,
  label: 'cat',
  kind: 'big',
  name: 'a big orange cat',
}

const config = resolveLanceDBConfig({
  uri: '/tmp/db',
  groupBy: ['label', 'kind'],
  idColumn: 'id',
  titleColumn: 'name',
  blobColumn: 'image_bytes',
  blobExt: 'png',
  vectorColumn: 'vector',
})

function makeAccessor(): { accessor: LanceDBAccessor; rowsMatching: ReturnType<typeof vi.fn> } {
  const rowsMatching = vi.fn().mockResolvedValue([ROW])
  const driver = {
    listTables: vi.fn().mockResolvedValue(['animals']),
    tableColumns: vi
      .fn()
      .mockResolvedValue(['id', 'label', 'kind', 'name', 'image_bytes', 'vector']),
    distinct: vi.fn().mockResolvedValue(['big']),
    rowsMatching,
  } as unknown as LanceDriver
  return { accessor: new LanceDBAccessor(driver, config), rowsMatching }
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: virtual.replace(/^\//, '') })
}

describe('lancedb readdir sizes', () => {
  it('selects every column except the vector and blob ones', async () => {
    const { accessor, rowsMatching } = makeAccessor()
    await readdir(accessor, spec('/animals/cat/big'), new RAMIndexCacheStore())
    expect(rowsMatching.mock.calls[0]?.[2]).toEqual(['id', 'label', 'kind', 'name'])
  })

  it('seeds the exact card size and leaves the blob unsized', async () => {
    const { accessor } = makeAccessor()
    const idx = new RAMIndexCacheStore()
    await readdir(accessor, spec('/animals/cat/big'), idx)
    const card = await idx.get('/animals/cat/big/1.md')
    expect(card.entry?.size).toBe(renderCard(ROW, config).byteLength)
    const blob = await idx.get('/animals/cat/big/1.png')
    expect(blob.entry?.size).toBeNull()
  })

  it('lists without an index when none is given', async () => {
    const { accessor } = makeAccessor()
    const out = await readdir(accessor, spec('/animals/cat/big'))
    expect(out).toEqual(['/animals/cat/big/1.md', '/animals/cat/big/1.png'])
  })
})

const CAP = 5
const WIDE = 40

function wideAccessor(): {
  accessor: LanceDBAccessor
  rowsMatching: ReturnType<typeof vi.fn>
} {
  // The driver stands in for the store: the cap is a `limit` on the query, so
  // the fake applies the prefix and the limit in that order, exactly as the
  // SQL does.
  const rows: LanceRow[] = []
  for (let i = 0; i < WIDE; i += 1) rows.push({ id: `doc-${String(i).padStart(3, '0')}` })
  const rowsMatching = vi
    .fn()
    .mockImplementation(
      (_t: string, _f: unknown, _c: string[], limit: number, _id: string, prefix: string) =>
        Promise.resolve(rows.filter((r) => String(r.id).startsWith(prefix)).slice(0, limit)),
    )
  const driver = {
    listTables: vi.fn().mockResolvedValue(['wide']),
    tableColumns: vi.fn().mockResolvedValue(['id']),
    distinct: vi.fn().mockResolvedValue(['all']),
    rowsMatching,
  } as unknown as LanceDriver
  const wideConfig = resolveLanceDBConfig({
    uri: '/tmp/db',
    table: 'wide',
    groupBy: ['label'],
    idColumn: 'id',
    titleColumn: 'id',
    maxRows: CAP,
  })
  return { accessor: new LanceDBAccessor(driver, wideConfig), rowsMatching }
}

function globbed(virtual: string, pattern: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: virtual.replace(/^\//, ''),
    pattern,
  })
}

function ids(paths: string[]): string[] {
  return paths.map((p) => (p.split('/').pop() ?? '').split('.')[0] ?? '')
}

describe('lancedb readdir narrows a capped listing', () => {
  it('pushes a row glob prefix into the query', async () => {
    // The cap covers doc-000..doc-004, so filtering it would answer nothing.
    const { accessor, rowsMatching } = wideAccessor()
    const out = await readdir(accessor, globbed('/all', 'doc-03*'), new RAMIndexCacheStore())
    expect(ids(out)).toEqual(['doc-030', 'doc-031', 'doc-032', 'doc-033', 'doc-034'])
    expect(rowsMatching.mock.calls[0]?.[5]).toBe('doc-03')
  })

  it('cuts the prefix at the suffix so a leaf glob cannot ask for a dot', async () => {
    const { accessor, rowsMatching } = wideAccessor()
    await readdir(accessor, globbed('/all', 'doc-039.m*'), new RAMIndexCacheStore())
    expect(rowsMatching.mock.calls[0]?.[5]).toBe('doc-039')
  })

  it('sends no prefix for a glob with no literal head', async () => {
    const { accessor, rowsMatching } = wideAccessor()
    const out = await readdir(accessor, globbed('/all', '*9.md'), new RAMIndexCacheStore())
    expect(ids(out)).toEqual(['doc-000', 'doc-001', 'doc-002', 'doc-003', 'doc-004'])
    expect(rowsMatching.mock.calls[0]?.[5]).toBe('')
  })

  it('does not cache a narrowed listing as the directory', async () => {
    const { accessor } = wideAccessor()
    const idx = new RAMIndexCacheStore()
    await readdir(accessor, globbed('/all', 'doc-03*'), idx)
    const listed = await idx.listDir('/all/')
    expect(listed.entries === undefined || listed.entries === null).toBe(true)
    const plain = await readdir(accessor, spec('/all'), idx)
    expect(ids(plain)).toEqual(['doc-000', 'doc-001', 'doc-002', 'doc-003', 'doc-004'])
  })
})

const SLASHED = ['a/b', 'a∕b', '', '.env']

function slashedAccessor(): { accessor: LanceDBAccessor; distinct: ReturnType<typeof vi.fn> } {
  // The driver stands in for the store: it ignores the prefix and honors the
  // test, so what the listing keeps is the test's doing.
  const distinct = vi
    .fn()
    .mockImplementation(
      (
        _t: string,
        _c: string,
        _f: unknown,
        _l: number,
        _p: string,
        keep?: (value: string) => boolean,
      ) => Promise.resolve(SLASHED.filter((value) => keep === undefined || keep(value))),
    )
  const driver = {
    listTables: vi.fn().mockResolvedValue(['animals']),
    tableColumns: vi.fn().mockResolvedValue(['id', 'label', 'kind', 'name']),
    distinct,
    rowsMatching: vi.fn().mockResolvedValue([ROW]),
  } as unknown as LanceDriver
  return { accessor: new LanceDBAccessor(driver, config), distinct }
}

describe('lancedb group values holding a slash', () => {
  it('give every value its own directory', async () => {
    // `a/b` renders as `a∕b` and `a∕b` as `a⁄∕b`, so neither hides the other.
    const { accessor } = slashedAccessor()
    const out = await readdir(accessor, spec('/animals'))
    expect(new Set(out)).toEqual(
      new Set(['/animals/a∕b', '/animals/a⁄∕b', '/animals/⁄', '/animals/⁄.env']),
    )
  })

  it('filter a rendered directory for exactly its own value', async () => {
    const { accessor, distinct } = slashedAccessor()
    await readdir(accessor, spec('/animals/a∕b'))
    expect(distinct.mock.calls[0]?.[2]).toEqual({ label: 'a/b' })
    await readdir(accessor, spec('/animals/a⁄∕b'))
    expect(distinct.mock.calls[1]?.[2]).toEqual({ label: 'a∕b' })
  })

  it('push the decoded value prefix down and keep only the rendered matches', async () => {
    const { accessor, distinct } = slashedAccessor()
    const out = await readdir(accessor, globbed('/animals', 'a∕*'))
    expect(out).toEqual(['/animals/a∕b'])
    expect(distinct.mock.calls[0]?.[4]).toBe('a/')
  })

  it('keep a blank and a dot-led value listable and filter for them', async () => {
    // A blank value rendered as `unknown` and a dot-led one as a hidden
    // segment; each carries the escape lead and filters for its own value.
    const { accessor, distinct } = slashedAccessor()
    await readdir(accessor, spec('/animals/⁄'))
    expect(distinct.mock.calls[0]?.[2]).toEqual({ label: '' })
    await readdir(accessor, spec('/animals/⁄.env'))
    expect(distinct.mock.calls[1]?.[2]).toEqual({ label: '.env' })
  })
})

function crowdedAccessor(): { accessor: LanceDBAccessor; distinct: ReturnType<typeof vi.fn> } {
  // The driver stands in for the store: the prefix narrows the rows, the test
  // bounds the cap by what it keeps, and the cap cuts the head of what is
  // left, exactly as the streamed query does.
  const labels: string[] = []
  for (let i = 0; i < WIDE; i += 1) labels.push('all')
  labels.push('', '.env', 'a∕x')
  const distinct = vi
    .fn()
    .mockImplementation(
      (
        _t: string,
        _c: string,
        _f: unknown,
        limit: number,
        prefix: string,
        keep?: (value: string) => boolean,
      ) => {
        const narrowed = labels.filter((value) => value.startsWith(prefix))
        const kept = keep === undefined ? narrowed : narrowed.filter(keep)
        return Promise.resolve([...new Set(kept.slice(0, limit))])
      },
    )
  const driver = {
    listTables: vi.fn().mockResolvedValue(['crowded']),
    tableColumns: vi.fn().mockResolvedValue(['id', 'label']),
    distinct,
    rowsMatching: vi.fn().mockResolvedValue([]),
  } as unknown as LanceDriver
  const crowdedConfig = resolveLanceDBConfig({
    uri: '/tmp/db',
    table: 'crowded',
    groupBy: ['label'],
    idColumn: 'id',
    titleColumn: 'label',
    maxRows: CAP,
  })
  return { accessor: new LanceDBAccessor(driver, crowdedConfig), distinct }
}

describe('lancedb group globs past the cap', () => {
  it('reach a value no value prefix spells', async () => {
    // `⁄` alone stands for no value prefix (a blank value, a dot-led one, one
    // opening with `∕` or `⁄` all render behind it), so nothing narrows the
    // query; the cap counts the renderings that match rather than the rows at
    // the head of the table. The plain listing stays capped.
    const { accessor, distinct } = crowdedAccessor()
    expect(await readdir(accessor, spec('/'))).toEqual(['/all'])
    expect(await readdir(accessor, globbed('/', '⁄*'))).toEqual(['/⁄', '/⁄.env'])
    expect(distinct.mock.calls[1]?.[4]).toBe('')
  })

  it('count the matches when the head is cut inside an escape', async () => {
    // `a⁄` decodes to `a`, which every `all` row also starts with: the LIKE
    // loses nothing, and the cap counts the renderings that really start
    // with `a⁄` rather than the rows the LIKE let through.
    const { accessor, distinct } = crowdedAccessor()
    expect(await readdir(accessor, globbed('/', 'a⁄*'))).toEqual(['/a⁄∕x'])
    expect(distinct.mock.calls[0]?.[4]).toBe('a')
  })
})
