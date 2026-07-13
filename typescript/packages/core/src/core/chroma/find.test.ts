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
import type * as ClientModule from './_client.ts'
import type * as StatModule from './stat.ts'
import type * as WalkModule from './walk.ts'

vi.mock('./walk.ts', async () => {
  const actual = await vi.importActual<typeof WalkModule>('./walk.ts')
  return { ...actual, walk: vi.fn() }
})

vi.mock('./stat.ts', async () => {
  const actual = await vi.importActual<typeof StatModule>('./stat.ts')
  return { ...actual, stat: vi.fn() }
})

vi.mock('./_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./_client.ts')
  return { ...actual, fetchPathTree: vi.fn() }
})

import type { ChromaAccessor } from '../../accessor/chroma.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import * as clientMod from './_client.ts'
import { find } from './find.ts'
import * as statMod from './stat.ts'
import * as walkMod from './walk.ts'

const ACCESSOR = {} as ChromaAccessor
const INDEX = {} as IndexCacheStore
const ROOT = new PathSpec({ resourcePath: '', virtual: '/', directory: '/' })

function mockStats(stats: Record<string, { size?: number | null; modified?: string }>): void {
  vi.mocked(statMod.stat).mockImplementation((_accessor, spec) => {
    const key = typeof spec === 'string' ? spec : spec.virtual
    const entry = stats[key]
    if (entry === undefined) return Promise.reject(new Error(`ENOENT: ${key}`))
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

describe('chroma core find', () => {
  beforeEach(() => {
    vi.mocked(walkMod.walk).mockReset()
    vi.mocked(statMod.stat).mockReset()
  })

  it('parses naive modified timestamps as UTC', async () => {
    vi.mocked(walkMod.walk).mockResolvedValue(['/naive.txt'])
    mockStats({ '/naive.txt': { size: 1, modified: '2026-01-05T00:00:00' } })
    const out = await find(
      ACCESSOR,
      ROOT,
      {
        mtimeMin: Date.parse('2026-01-04T23:30:00Z') / 1000,
        mtimeMax: Date.parse('2026-01-05T00:30:00Z') / 1000,
      },
      INDEX,
    )
    expect(out).toEqual(['/naive.txt'])
  })

  it('excludes entries with unparseable modified times under mtime filters', async () => {
    vi.mocked(walkMod.walk).mockResolvedValue(['/junk.txt'])
    mockStats({ '/junk.txt': { size: 1, modified: 'not-a-date' } })
    const out = await find(ACCESSOR, ROOT, { mtimeMin: 0 }, INDEX)
    expect(out).toEqual([])
  })

  it('counts sizeless files as size 0 under -size filters', async () => {
    vi.mocked(walkMod.walk).mockResolvedValue(['/sized.txt', '/sizeless.txt'])
    vi.mocked(clientMod.fetchPathTree).mockResolvedValue(
      JSON.stringify({ 'sized.txt': { size: 12 }, 'sizeless.txt': { size: null } }),
    )
    mockStats({ '/sized.txt': { size: 12 }, '/sizeless.txt': { size: null } })
    const large = await find(ACCESSOR, ROOT, { type: 'f', minSize: 1 }, new RAMIndexCacheStore())
    expect(large).toEqual(['/sized.txt'])
    const empty = await find(ACCESSOR, ROOT, { type: 'f', maxSize: 0 }, new RAMIndexCacheStore())
    expect(empty).toEqual(['/sizeless.txt'])
  })

  it('keeps timezone-aware timestamps unchanged', async () => {
    vi.mocked(walkMod.walk).mockResolvedValue(['/aware.txt'])
    mockStats({ '/aware.txt': { size: 1, modified: '2026-01-05T02:00:00+02:00' } })
    const out = await find(
      ACCESSOR,
      ROOT,
      {
        mtimeMin: Date.parse('2026-01-04T23:30:00Z') / 1000,
        mtimeMax: Date.parse('2026-01-05T00:30:00Z') / 1000,
      },
      INDEX,
    )
    expect(out).toEqual(['/aware.txt'])
  })
})
