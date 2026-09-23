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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, iterLatest: vi.fn() }
})

import type { FindOptions } from '@struktoai/mirage-core/vfs/base'
import { PathSpec } from '@struktoai/mirage-core/types'
import { GridFSAccessor } from '../../accessor/gridfs.ts'
import type { GridFSConfig } from '../../vfs/gridfs/config.ts'
import type { GridFSFileDoc } from './client.ts'
import * as clientMod from './client.ts'
import { buildQuery, globRegex } from './driver.ts'
import { find } from './find.ts'

function matches(cond: Record<string, unknown>, value: string): boolean {
  const regex = cond as { $regex: string; $options?: string }
  return new RegExp(regex.$regex, regex.$options ?? '').test(value)
}

describe('globRegex', () => {
  it('keeps * within a path segment', () => {
    const rx = globRegex('*.csv')
    expect(rx).not.toBeNull()
    expect(new RegExp(`^${String(rx)}$`).test('b.csv')).toBe(true)
    expect(new RegExp(`^${String(rx)}$`).test('sub/b.csv')).toBe(false)
  })

  it('translates ? to a single non-slash char', () => {
    const rx = globRegex('a?.txt')
    expect(new RegExp(`^${String(rx)}$`).test('ab.txt')).toBe(true)
    expect(new RegExp(`^${String(rx)}$`).test('a.txt')).toBe(false)
  })

  it('escapes regex literals', () => {
    const rx = globRegex('a+b.txt')
    expect(new RegExp(`^${String(rx)}$`).test('a+b.txt')).toBe(true)
    expect(new RegExp(`^${String(rx)}$`).test('aab.txt')).toBe(false)
  })

  it('bails on character classes', () => {
    expect(globRegex('[ab].txt')).toBeNull()
  })
})

describe('buildQuery', () => {
  it('prefix only', () => {
    expect(buildQuery('data/', {}, true)).toEqual({ filename: { $regex: '^data/' } })
  })

  it('name matches files and markers at any depth', () => {
    const query = buildQuery('data/', { name: '*.csv' }, true) as {
      $and: { filename: Record<string, unknown> }[]
    }
    const nameCond = query.$and[1]?.filename ?? {}
    expect(matches(nameCond, 'data/b.csv')).toBe(true)
    expect(matches(nameCond, 'data/sub/deep.csv')).toBe(true)
    expect(matches(nameCond, 'data/sub.csv/')).toBe(true)
    expect(matches(nameCond, 'data/b.txt')).toBe(false)
  })

  it('iname is case-insensitive', () => {
    const query = buildQuery('', { iname: '*.CSV' }, true) as { filename: Record<string, unknown> }
    expect(query.filename.$options).toBe('i')
    expect(matches(query.filename, 'b.csv')).toBe(true)
  })

  it('type narrows to files or markers', () => {
    expect(buildQuery('', { type: 'f' }, true)).toEqual({
      filename: { $not: { $regex: '/$' } },
    })
    expect(buildQuery('', { type: 'd' }, true)).toEqual({ filename: { $regex: '/$' } })
  })

  it('size lets markers through', () => {
    const query = buildQuery('', { minSize: 1, maxSize: 100 }, true) as {
      $or: Record<string, unknown>[]
    }
    expect(query.$or).toContainEqual({ length: { $gte: 1, $lte: 100 } })
    expect(query.$or).toContainEqual({ filename: { $regex: '/$' } })
  })

  it('no pushdown keeps prefix only', () => {
    expect(buildQuery('data/', { name: '*.csv', type: 'f', minSize: 1 }, false)).toEqual({
      filename: { $regex: '^data/' },
    })
  })

  it('unpushable glob falls back to prefix', () => {
    expect(buildQuery('data/', { name: '[ab].csv' }, true)).toEqual({
      filename: { $regex: '^data/' },
    })
  })
})

async function* docsGen(docs: GridFSFileDoc[]) {
  for (const doc of docs) {
    yield await Promise.resolve(doc)
  }
}

function runFind(
  docs: [string, number][],
  options: FindOptions = {},
): { out: Promise<string[]>; queries: Record<string, unknown>[] } {
  const queries: Record<string, unknown>[] = []
  vi.mocked(clientMod.iterLatest).mockImplementation((_accessor, query) => {
    queries.push(query)
    return docsGen(
      docs.map(
        ([filename, length]) => ({ filename, length, uploadDate: new Date(0) }) as GridFSFileDoc,
      ),
    )
  })
  const accessor = new GridFSAccessor({
    uri: 'mongodb://localhost:27017',
    database: 'db',
  } as GridFSConfig)
  const spec = new PathSpec({
    vfsPath: 'data',
    virtual: '/mnt/data',
    directory: '/mnt/',
  })
  return { out: find(accessor, spec, options), queries }
}

describe('gridfs core find', () => {
  beforeEach(() => {
    vi.mocked(clientMod.iterLatest).mockReset()
  })

  it('synthesizes implicit dirs without narrowing the query', async () => {
    const { out, queries } = runFind([['data/a/b.txt', 3]], { type: 'd' })
    await expect(out).resolves.toEqual(['/data', '/data/a'])
    expect(queries).toEqual([{ filename: { $regex: '^data/' } }])
  })

  it('-name without -type f scans the prefix only', async () => {
    const { out, queries } = runFind([['data/logs/x.txt', 1]], { name: 'logs' })
    await expect(out).resolves.toEqual(['/data/logs'])
    expect(queries).toEqual([{ filename: { $regex: '^data/' } }])
  })

  it('-type f keeps the pushdown', async () => {
    const { out, queries } = runFind([['data/a/b.txt', 3]], { type: 'f', name: '*.txt' })
    await expect(out).resolves.toEqual(['/data/a/b.txt'])
    expect(queries[0]).toHaveProperty('$and')
  })

  it('unordered marker and file emit no duplicates', async () => {
    const { out } = runFind(
      [
        ['data/a/x.txt', 1],
        ['data/a/', 0],
      ],
      { type: 'd' },
    )
    await expect(out).resolves.toEqual(['/data', '/data/a'])
  })

  it('emits a file shadowed by an implicit dir once', async () => {
    const docs: [string, number][] = [
      ['data/a', 1],
      ['data/a/b.txt', 2],
    ]
    await expect(runFind(docs).out).resolves.toEqual(['/data', '/data/a', '/data/a/b.txt'])
    await expect(runFind(docs, { type: 'd' }).out).resolves.toEqual(['/data', '/data/a'])
    await expect(runFind(docs, { type: 'f' }).out).resolves.toEqual(['/data/a', '/data/a/b.txt'])
  })

  it('-empty matches a marker-only start dir', async () => {
    const { out } = runFind([['data/', 0]], { empty: true })
    await expect(out).resolves.toEqual(['/data'])
  })

  it('-empty rejects a populated start dir', async () => {
    const { out } = runFind([['data/x.txt', 3]], { empty: true })
    await expect(out).resolves.toEqual([])
  })
})
