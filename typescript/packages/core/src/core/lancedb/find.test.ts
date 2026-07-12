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

import { mountKey } from '../../utils/key_prefix.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReaddirModule from './readdir.ts'
import type * as StatModule from './stat.ts'

vi.mock('./readdir.ts', async () => {
  const actual = await vi.importActual<typeof ReaddirModule>('./readdir.ts')
  return { ...actual, readdir: vi.fn() }
})

vi.mock('./stat.ts', async () => {
  const actual = await vi.importActual<typeof StatModule>('./stat.ts')
  return { ...actual, stat: vi.fn() }
})

import { LanceDBAccessor } from '../../accessor/lancedb.ts'
import type { LanceDriver } from './_driver.ts'
import type { LanceDBConfigResolved } from '../../resource/lancedb/config.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../../resource/base.ts'
import { walkFind } from '../generic/find.ts'
import { isDirName } from './readdir.ts'
import * as readdirMod from './readdir.ts'
import * as statMod from './stat.ts'

async function find(
  accessor: LanceDBAccessor,
  path: PathSpec,
  options: FindOptions = {},
  index?: IndexCacheStore,
): Promise<string[]> {
  return walkFind(
    path,
    {
      readdir: (spec, idx) => readdirMod.readdir(accessor, spec, idx),
      stat: (spec, idx) => statMod.stat(accessor, spec, idx),
      isDirName: (child) => isDirName(child, accessor.config),
    },
    options,
    index,
  )
}

function makeAccessor(): LanceDBAccessor {
  const config = { blobColumn: null, blobExt: 'bin' } as LanceDBConfigResolved
  return new LanceDBAccessor({} as LanceDriver, config)
}

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

function mockTree(tree: Record<string, string[]>): void {
  vi.mocked(readdirMod.readdir).mockImplementation((_accessor, spec) => {
    const key = typeof spec === 'string' ? spec : spec.virtual
    const children = tree[key]
    if (children === undefined) return Promise.reject(enoent(key))
    return Promise.resolve(children)
  })
}

function mockStats(stats: Record<string, { size?: number; modified?: string }>): void {
  vi.mocked(statMod.stat).mockImplementation((_accessor, spec) => {
    const key = typeof spec === 'string' ? spec : spec.virtual
    const entry = stats[key]
    if (entry === undefined) return Promise.reject(enoent(key))
    const name = key.split('/').pop() ?? ''
    return Promise.resolve(
      new FileStat({
        name,
        size: entry.size ?? null,
        modified: entry.modified ?? null,
        type: entry.size === undefined ? FileType.DIRECTORY : FileType.TEXT,
      }),
    )
  })
}

const TREE: Record<string, string[]> = {
  '/': ['/tbl'],
  '/tbl': ['/tbl/grp', '/tbl/b.md', '/tbl/a.md'],
  '/tbl/grp': ['/tbl/grp/c.md'],
}

const ROOT = new PathSpec({ resourcePath: '', virtual: '/', directory: '/' })

describe('lancedb core find', () => {
  beforeEach(() => {
    vi.mocked(readdirMod.readdir).mockReset()
    vi.mocked(statMod.stat).mockReset()
  })

  it('walks recursively classifying row files by extension', async () => {
    mockTree(TREE)
    const out = await find(makeAccessor(), ROOT)
    expect(out).toEqual(['/tbl', '/tbl/a.md', '/tbl/b.md', '/tbl/grp', '/tbl/grp/c.md'])
    const files = await find(makeAccessor(), ROOT, { type: 'f' })
    expect(files).toEqual(['/tbl/a.md', '/tbl/b.md', '/tbl/grp/c.md'])
    const dirs = await find(makeAccessor(), ROOT, { type: 'd' })
    expect(dirs).toEqual(['/tbl', '/tbl/grp'])
  })

  it('never stats entries for classification', async () => {
    mockTree(TREE)
    await find(makeAccessor(), ROOT)
    expect(vi.mocked(statMod.stat)).not.toHaveBeenCalled()
  })

  it('sorts by codepoint, not locale', async () => {
    mockTree({ '/': ['/Zeta.md', '/alpha.md'] })
    const out = await find(makeAccessor(), ROOT)
    expect(out).toEqual(['/Zeta.md', '/alpha.md'])
  })

  it('keeps a child whose readdir raises ENOENT but stops descending', async () => {
    mockTree({ '/': ['/ghost'] })
    const out = await find(makeAccessor(), ROOT)
    expect(out).toEqual(['/ghost'])
  })

  it('propagates non-ENOENT readdir errors', async () => {
    vi.mocked(readdirMod.readdir).mockImplementation((_accessor, spec) => {
      const key = typeof spec === 'string' ? spec : spec.virtual
      if (key === '/') return Promise.resolve(['/bad'])
      return Promise.reject(new Error('rate limited'))
    })
    await expect(find(makeAccessor(), ROOT)).rejects.toThrow('rate limited')
  })

  it('parses naive modified timestamps as UTC', async () => {
    mockTree({ '/': ['/naive.md'] })
    mockStats({ '/naive.md': { size: 1, modified: '2026-01-05T00:00:00' } })
    const out = await find(makeAccessor(), ROOT, {
      mtimeMin: Date.parse('2026-01-04T23:30:00Z') / 1000,
      mtimeMax: Date.parse('2026-01-05T00:30:00Z') / 1000,
    })
    expect(out).toEqual(['/naive.md'])
  })

  it('strips the mount prefix from returned keys', async () => {
    mockTree({
      '/mnt/ldb': ['/mnt/ldb/tbl'],
      '/mnt/ldb/tbl': ['/mnt/ldb/tbl/a.md'],
    })
    const root = new PathSpec({
      virtual: '/mnt/ldb',
      directory: '/mnt/ldb',
      resourcePath: mountKey('/mnt/ldb', '/mnt/ldb'),
    })
    const out = await find(makeAccessor(), root)
    expect(out).toEqual(['/tbl', '/tbl/a.md'])
  })
})
