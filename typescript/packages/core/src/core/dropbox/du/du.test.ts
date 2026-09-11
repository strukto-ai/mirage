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

import { mountKey } from '../../../utils/key_prefix.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReaddirModule from '../readdir.ts'
import type * as StatModule from '../stat.ts'

vi.mock('../readdir.ts', async () => {
  const actual = await vi.importActual<typeof ReaddirModule>('../readdir.ts')
  return { ...actual, readdir: vi.fn() }
})

vi.mock('../stat.ts', async () => {
  const actual = await vi.importActual<typeof StatModule>('../stat.ts')
  return { ...actual, stat: vi.fn() }
})

import { DropboxAccessor } from '../../../accessor/dropbox.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { enoent } from '../../../utils/errors.ts'
import { DropboxApiError, type DropboxTokenManager } from '../client.ts'
import { size, entries } from './index.ts'
import * as readdirMod from '../readdir.ts'
import * as statMod from '../stat.ts'

const STUB_TM = {} as DropboxTokenManager

function makeAccessor(): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: STUB_TM })
}

function mockTree(tree: Record<string, string[]>): void {
  vi.mocked(readdirMod.readdir).mockImplementation((_accessor, spec) => {
    const children = tree[spec.virtual]
    if (children === undefined) return Promise.reject(enoent(spec.virtual))
    return Promise.resolve(children)
  })
}

function mockStats(stats: Record<string, { size?: number }>): void {
  vi.mocked(statMod.stat).mockImplementation((_accessor, spec) => {
    const entry = stats[spec.virtual]
    if (entry === undefined) return Promise.reject(enoent(spec.virtual))
    const name = spec.virtual.split('/').pop() ?? ''
    return Promise.resolve(
      new FileStat({
        name,
        size: entry.size ?? null,
        modified: null,
        type: entry.size === undefined ? FileType.DIRECTORY : FileType.FILE,
      }),
    )
  })
}

const TREE: Record<string, string[]> = {
  '/': ['/docs/', '/notes.txt'],
  '/docs': ['/docs/readme.md', '/docs/inner/'],
  '/docs/inner': ['/docs/inner/deep.md'],
}

const SIZES: Record<string, { size?: number }> = {
  '/': {},
  '/docs': {},
  '/docs/inner': {},
  '/docs/inner/deep.md': { size: 500_000 },
  '/docs/readme.md': { size: 2048 },
  '/notes.txt': { size: 10 },
}

const ROOT = new PathSpec({ resourcePath: '', virtual: '/', directory: '/' })

describe('dropbox core du', () => {
  beforeEach(() => {
    vi.mocked(readdirMod.readdir).mockReset()
    vi.mocked(statMod.stat).mockReset()
  })

  it('sums file sizes across a nested tree', async () => {
    mockTree(TREE)
    mockStats(SIZES)
    expect(await size(makeAccessor(), ROOT)).toBe(502_058)
  })

  it('returns the size of a single file', async () => {
    mockTree(TREE)
    mockStats(SIZES)
    const file = new PathSpec({
      resourcePath: 'notes.txt',
      virtual: '/notes.txt',
      directory: '/notes.txt',
    })
    expect(await size(makeAccessor(), file)).toBe(10)
  })

  it('returns per-file entries with prefix stripped plus the total', async () => {
    mockTree({
      '/mnt/dbx': ['/mnt/dbx/docs/', '/mnt/dbx/notes.txt'],
      '/mnt/dbx/docs': ['/mnt/dbx/docs/readme.md'],
    })
    mockStats({
      '/mnt/dbx': {},
      '/mnt/dbx/docs': {},
      '/mnt/dbx/docs/readme.md': { size: 2048 },
      '/mnt/dbx/notes.txt': { size: 10 },
    })
    const root = new PathSpec({
      virtual: '/mnt/dbx',
      directory: '/mnt/dbx',
      resourcePath: mountKey('/mnt/dbx', '/mnt/dbx'),
    })
    const [found, total] = await entries(makeAccessor(), root)
    expect(found).toEqual([
      ['/docs/readme.md', 2048],
      ['/notes.txt', 10],
    ])
    expect(total).toBe(2058)
  })

  it('counts an unreadable subtree as zero instead of throwing', async () => {
    mockTree({ '/': ['/docs/', '/notes.txt'], '/docs': ['/docs/readme.md', '/docs/inner/'] })
    mockStats(SIZES)
    expect(await size(makeAccessor(), ROOT)).toBe(2058)
  })

  it('returns zero when stat fails on the root', async () => {
    mockTree(TREE)
    mockStats({})
    expect(await size(makeAccessor(), ROOT)).toBe(0)
  })

  it('propagates a 5xx instead of under-counting the total', async () => {
    // A server error is not absence: swallowing it (the old bare catch)
    // silently reported a wrong total. Only ENOENT counts as zero.
    mockTree(TREE)
    vi.mocked(statMod.stat).mockRejectedValue(new DropboxApiError('boom', 500))
    await expect(size(makeAccessor(), ROOT)).rejects.toMatchObject({ status: 500 })
  })
})
