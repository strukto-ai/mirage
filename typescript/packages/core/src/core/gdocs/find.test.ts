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

import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/_client.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../../resource/base.ts'
import { walkFind } from '../generic/find.ts'
import { isDirName } from './readdir.ts'
import * as readdirMod from './readdir.ts'
import * as statMod from './stat.ts'

async function find(
  accessor: GDocsAccessor,
  path: PathSpec,
  options: FindOptions = {},
  index?: IndexCacheStore,
): Promise<string[]> {
  return walkFind(
    path,
    {
      readdir: (spec, idx) => readdirMod.readdir(accessor, spec, idx),
      stat: (spec, idx) => statMod.stat(accessor, spec, idx),
      isDirName: (child) => isDirName(child),
    },
    options,
    index,
  )
}

const STUB_TM = {} as TokenManager

function makeAccessor(): GDocsAccessor {
  return new GDocsAccessor({ tokenManager: STUB_TM })
}

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

function mockTree(tree: Record<string, string[]>): void {
  vi.mocked(readdirMod.readdir).mockImplementation((_accessor, spec) => {
    const children = tree[spec.virtual]
    if (children === undefined) return Promise.reject(enoent(spec.virtual))
    return Promise.resolve(children)
  })
}

function mockStats(stats: Record<string, { size?: number | null; modified?: string }>): void {
  vi.mocked(statMod.stat).mockImplementation((_accessor, spec) => {
    const entry = stats[spec.virtual]
    if (entry === undefined) return Promise.reject(enoent(spec.virtual))
    const name = spec.virtual.split('/').pop() ?? ''
    return Promise.resolve(
      new FileStat({
        name,
        size: entry.size ?? null,
        modified: entry.modified ?? null,
        type: FileType.TEXT,
      }),
    )
  })
}

const RECENT = new Date(Date.now() - 2 * 3_600_000).toISOString()
const OLD = new Date(Date.now() - 10 * 86_400_000).toISOString()

const TREE: Record<string, string[]> = {
  '/': ['/owned', '/shared'],
  '/owned': ['/owned/Big__d2.gdoc.json', '/owned/Doc_A__d1.gdoc.json'],
  '/shared': [],
}

const STATS: Record<string, { size?: number | null; modified?: string }> = {
  '/owned/Big__d2.gdoc.json': { size: 2048, modified: OLD },
  '/owned/Doc_A__d1.gdoc.json': { size: null, modified: RECENT },
}

const ROOT = new PathSpec({ resourcePath: '', virtual: '/', directory: '/' })

describe('gdocs core find', () => {
  beforeEach(() => {
    vi.mocked(readdirMod.readdir).mockReset()
    vi.mocked(statMod.stat).mockReset()
    mockTree(TREE)
    mockStats(STATS)
  })

  it('classifies .gdoc.json entries as files and the rest as dirs without stat', async () => {
    const files = await find(makeAccessor(), ROOT, { type: 'f' })
    expect(files).toEqual(['/owned/Big__d2.gdoc.json', '/owned/Doc_A__d1.gdoc.json'])
    const dirs = await find(makeAccessor(), ROOT, { type: 'd' })
    expect(dirs).toEqual(['/owned', '/shared'])
    expect(vi.mocked(statMod.stat)).not.toHaveBeenCalled()
  })

  it('treats a null size as 0 for size filters, dirs contribute 0 too', async () => {
    const out = await find(makeAccessor(), ROOT, { minSize: 1024 })
    expect(out).toEqual(['/owned/Big__d2.gdoc.json'])
  })

  it('filters by mtime, excluding dirs without a modified time', async () => {
    const out = await find(makeAccessor(), ROOT, { mtimeMin: Date.now() / 1000 - 86_400 })
    expect(out).toEqual(['/owned/Doc_A__d1.gdoc.json'])
  })

  it('matches pathPattern against the full path', async () => {
    const out = await find(makeAccessor(), ROOT, { pathPattern: '/owned/*' })
    expect(out).toEqual(['/owned/Big__d2.gdoc.json', '/owned/Doc_A__d1.gdoc.json'])
  })
})
