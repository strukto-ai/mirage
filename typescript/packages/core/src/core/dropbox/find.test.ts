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

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import type { DropboxTokenManager } from './_client.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../../resource/base.ts'
import { walkFind } from '../generic/find.ts'
import { isDirName } from './readdir.ts'
import * as readdirMod from './readdir.ts'
import * as statMod from './stat.ts'

async function find(
  accessor: DropboxAccessor,
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

const STUB_TM = {} as DropboxTokenManager

function makeAccessor(): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: STUB_TM })
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

function mockStats(stats: Record<string, { size?: number; modified?: string }>): void {
  vi.mocked(statMod.stat).mockImplementation((_accessor, spec) => {
    const entry = stats[spec.virtual]
    if (entry === undefined) return Promise.reject(enoent(spec.virtual))
    const name = spec.virtual.split('/').pop() ?? ''
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
  '/': ['/docs/', '/notes.txt'],
  '/docs': ['/docs/readme.md', '/docs/inner/'],
  '/docs/inner': ['/docs/inner/deep.md'],
}

const ROOT = new PathSpec({ resourcePath: '', virtual: '/', directory: '/' })

const SIZES: Record<string, { size?: number; modified?: string }> = {
  '/docs': { modified: '2026-01-05T00:00:00Z' },
  '/docs/inner': { modified: '2026-01-01T00:00:00Z' },
  '/docs/inner/deep.md': { size: 500_000, modified: '2026-01-01T00:00:00Z' },
  '/docs/readme.md': { size: 2048, modified: '2026-01-05T00:00:00Z' },
  '/notes.txt': { size: 10, modified: '2026-01-10T00:00:00Z' },
}

describe('dropbox core find', () => {
  beforeEach(() => {
    vi.mocked(readdirMod.readdir).mockReset()
    vi.mocked(statMod.stat).mockReset()
    mockStats(SIZES)
  })

  it('walks recursively returning files and dirs sorted without trailing slashes', async () => {
    mockTree(TREE)
    const out = await find(makeAccessor(), ROOT)
    expect(out).toEqual([
      '/docs',
      '/docs/inner',
      '/docs/inner/deep.md',
      '/docs/readme.md',
      '/notes.txt',
    ])
  })

  it('filters by name glob', async () => {
    mockTree(TREE)
    const out = await find(makeAccessor(), ROOT, { name: '*.md' })
    expect(out).toEqual(['/docs/inner/deep.md', '/docs/readme.md'])
  })

  it('filters by type f and type d', async () => {
    mockTree(TREE)
    const files = await find(makeAccessor(), ROOT, { type: 'f' })
    expect(files).toEqual(['/docs/inner/deep.md', '/docs/readme.md', '/notes.txt'])
    const dirs = await find(makeAccessor(), ROOT, { type: 'd' })
    expect(dirs).toEqual(['/docs', '/docs/inner'])
  })

  it('honors maxDepth and minDepth', async () => {
    mockTree(TREE)
    const shallow = await find(makeAccessor(), ROOT, { maxDepth: 1 })
    expect(shallow).toEqual(['/docs', '/notes.txt'])
    const deep = await find(makeAccessor(), ROOT, { minDepth: 2 })
    expect(deep).toEqual(['/docs/inner', '/docs/inner/deep.md', '/docs/readme.md'])
  })

  it('strips the mount prefix from returned keys', async () => {
    mockTree({
      '/mnt/dbx': ['/mnt/dbx/docs/', '/mnt/dbx/notes.txt'],
      '/mnt/dbx/docs': ['/mnt/dbx/docs/readme.md'],
    })
    const root = new PathSpec({
      virtual: '/mnt/dbx',
      directory: '/mnt/dbx',
      resourcePath: mountKey('/mnt/dbx', '/mnt/dbx'),
    })
    const out = await find(makeAccessor(), root)
    expect(out).toEqual(['/docs', '/docs/readme.md', '/notes.txt'])
  })

  it('does not stat slash-marked directory entries', async () => {
    mockTree(TREE)
    await find(makeAccessor(), ROOT, { name: '*.md' })
    const statted = vi.mocked(statMod.stat).mock.calls.map((c) => c[1].virtual)
    expect(statted).not.toContain('/docs')
    expect(statted).not.toContain('/docs/inner')
  })

  it('filters by minSize with directories contributing size 0', async () => {
    mockTree(TREE)
    mockStats(SIZES)
    const out = await find(makeAccessor(), ROOT, { minSize: 1024 })
    expect(out).toEqual(['/docs/inner/deep.md', '/docs/readme.md'])
  })

  it('filters files by maxSize', async () => {
    mockTree(TREE)
    mockStats(SIZES)
    const out = await find(makeAccessor(), ROOT, { maxSize: 100, type: 'f' })
    expect(out).toEqual(['/notes.txt'])
  })

  it('stats the start path plus files for type detection and size filtering only', async () => {
    mockTree(TREE)
    await find(makeAccessor(), ROOT, { name: '*.md', minSize: 1024 })
    const statted = [...new Set(vi.mocked(statMod.stat).mock.calls.map((c) => c[1].virtual))]
    expect(statted.sort()).toEqual(['/', '/docs/inner/deep.md', '/docs/readme.md', '/notes.txt'])
  })

  it('filters by mtimeMin and mtimeMax on files and dirs', async () => {
    mockTree(TREE)
    mockStats(SIZES)
    const cutoff = Date.parse('2026-01-03T00:00:00Z') / 1000
    const recent = await find(makeAccessor(), ROOT, { mtimeMin: cutoff })
    expect(recent).toEqual(['/docs', '/docs/readme.md', '/notes.txt'])
    const old = await find(makeAccessor(), ROOT, { mtimeMax: cutoff })
    expect(old).toEqual(['/docs/inner', '/docs/inner/deep.md'])
  })

  it('excludes entries without a modified time when mtime filter is set', async () => {
    mockTree(TREE)
    mockStats({ ...SIZES, '/notes.txt': { size: 10 } })
    const out = await find(makeAccessor(), ROOT, { mtimeMin: 0 })
    expect(out).toEqual(['/docs', '/docs/inner', '/docs/inner/deep.md', '/docs/readme.md'])
  })

  it('filters by pathPattern against the full path', async () => {
    mockTree(TREE)
    const out = await find(makeAccessor(), ROOT, { pathPattern: '*/inner/*' })
    expect(out).toEqual(['/docs/inner/deep.md'])
  })

  it('matches pathPattern against the display path', async () => {
    mockTree({
      '/mnt/dbx': ['/mnt/dbx/docs/', '/mnt/dbx/notes.txt'],
      '/mnt/dbx/docs': ['/mnt/dbx/docs/readme.md'],
    })
    const root = new PathSpec({
      virtual: '/mnt/dbx',
      directory: '/mnt/dbx',
      resourcePath: mountKey('/mnt/dbx', '/mnt/dbx'),
    })
    const out = await find(makeAccessor(), root, { pathPattern: '/mnt/dbx/docs/*' })
    expect(out).toEqual(['/docs/readme.md'])
  })

  it('matches any of orNames patterns', async () => {
    mockTree(TREE)
    const out = await find(makeAccessor(), ROOT, { orNames: ['*.txt', 'deep.*'] })
    expect(out).toEqual(['/docs/inner/deep.md', '/notes.txt'])
  })

  it('excludes names matching nameExclude', async () => {
    mockTree(TREE)
    const out = await find(makeAccessor(), ROOT, { nameExclude: '*.md' })
    expect(out).toEqual(['/docs', '/docs/inner', '/notes.txt'])
  })

  it('detects directories via stat when cached readdir entries lack trailing slashes', async () => {
    mockTree({
      '/': ['/docs', '/notes.txt'],
      '/docs': ['/docs/readme.md'],
    })
    mockStats(SIZES)
    const files = await find(makeAccessor(), ROOT, { type: 'f' })
    expect(files).toEqual(['/docs/readme.md', '/notes.txt'])
    const dirs = await find(makeAccessor(), ROOT, { type: 'd' })
    expect(dirs).toEqual(['/docs'])
  })

  it('sorts by codepoint, not locale', async () => {
    mockTree({ '/': ['/Zeta.txt', '/alpha.txt'] })
    mockStats({ '/Zeta.txt': { size: 1 }, '/alpha.txt': { size: 1 } })
    const out = await find(makeAccessor(), ROOT)
    expect(out).toEqual(['/Zeta.txt', '/alpha.txt'])
  })

  it('keeps a child whose readdir raises ENOENT but stops descending', async () => {
    mockTree({ '/': ['/ghost/'] })
    const out = await find(makeAccessor(), ROOT)
    expect(out).toEqual(['/ghost'])
  })

  it('propagates non-ENOENT readdir errors', async () => {
    vi.mocked(readdirMod.readdir).mockImplementation((_accessor, spec) => {
      if (spec.virtual === '/') return Promise.resolve(['/bad/'])
      return Promise.reject(new Error('rate limited'))
    })
    await expect(find(makeAccessor(), ROOT)).rejects.toThrow('rate limited')
  })

  it('parses naive modified timestamps as UTC', async () => {
    mockTree({ '/': ['/naive.txt'] })
    mockStats({ '/naive.txt': { size: 1, modified: '2026-01-05T00:00:00' } })
    const out = await find(makeAccessor(), ROOT, {
      mtimeMin: Date.parse('2026-01-04T23:30:00Z') / 1000,
      mtimeMax: Date.parse('2026-01-05T00:30:00Z') / 1000,
    })
    expect(out).toEqual(['/naive.txt'])
  })
})
