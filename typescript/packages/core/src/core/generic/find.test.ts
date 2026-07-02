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
import { describe, expect, it } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { isEnoent, modifiedTs, walkFind, type WalkFindDeps } from './find.ts'

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

function makeDeps(
  tree: Record<string, string[]>,
  stats: Record<string, { size?: number; modified?: string }> = {},
): WalkFindDeps {
  return {
    readdir: (spec) => {
      const children = tree[spec.virtual]
      if (children === undefined) return Promise.reject(enoent(spec.virtual))
      return Promise.resolve(children)
    },
    stat: (spec) => {
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
    },
    isDirName: (child) => (child.endsWith('/') ? true : null),
  }
}

const ROOT = new PathSpec({ resourcePath: '', virtual: '/', directory: '/' })

describe('walkFind', () => {
  it('walks recursively and sorts by codepoint', async () => {
    const deps = makeDeps(
      {
        '/': ['/docs/', '/Zeta.txt', '/alpha.txt'],
        '/docs': ['/docs/a.md'],
      },
      { '/Zeta.txt': { size: 1 }, '/alpha.txt': { size: 1 }, '/docs/a.md': { size: 1 } },
    )
    const out = await walkFind(ROOT, deps)
    expect(out).toEqual(['/Zeta.txt', '/alpha.txt', '/docs', '/docs/a.md'])
  })

  it('classifies slash-less entries via the stat fallback', async () => {
    const deps = makeDeps(
      { '/': ['/dir', '/file.txt'], '/dir': [] },
      { '/dir': {}, '/file.txt': { size: 1 } },
    )
    expect(await walkFind(ROOT, deps, { type: 'd' })).toEqual(['/dir'])
    expect(await walkFind(ROOT, deps, { type: 'f' })).toEqual(['/file.txt'])
  })

  it('treats entries whose stat fails as files', async () => {
    const deps = makeDeps({ '/': ['/phantom'] })
    expect(await walkFind(ROOT, deps, { type: 'f' })).toEqual(['/phantom'])
  })

  it('swallows ENOENT from readdir but propagates other errors', async () => {
    const missing = makeDeps({ '/': ['/gone/'] })
    expect(await walkFind(ROOT, missing, {})).toEqual(['/gone'])
    const limited: WalkFindDeps = {
      ...makeDeps({}),
      readdir: (spec) =>
        spec.virtual === '/'
          ? Promise.resolve(['/bad/'])
          : Promise.reject(new Error('rate limited')),
    }
    await expect(walkFind(ROOT, limited)).rejects.toThrow('rate limited')
  })

  it('lists nothing for maxDepth 0 per the GNU depth convention', async () => {
    const deps = makeDeps({ '/': ['/a.txt'] }, { '/a.txt': { size: 1 } })
    expect(await walkFind(ROOT, deps, { maxDepth: 0 })).toEqual([])
  })

  it('strips the mount prefix from returned keys', async () => {
    const deps = makeDeps({ '/mnt/x': ['/mnt/x/a.txt'] }, { '/mnt/x/a.txt': { size: 1 } })
    const root = new PathSpec({
      virtual: '/mnt/x',
      directory: '/mnt/x',
      resourcePath: mountKey('/mnt/x', '/mnt/x'),
    })
    expect(await walkFind(root, deps)).toEqual(['/a.txt'])
  })

  it('filters mtime using naive timestamps as UTC', async () => {
    const deps = makeDeps(
      { '/': ['/naive.txt'] },
      { '/naive.txt': { size: 1, modified: '2026-01-05T00:00:00' } },
    )
    const out = await walkFind(ROOT, deps, {
      mtimeMin: Date.parse('2026-01-04T23:30:00Z') / 1000,
      mtimeMax: Date.parse('2026-01-05T00:30:00Z') / 1000,
    })
    expect(out).toEqual(['/naive.txt'])
  })

  it('keeps a child whose readdir raises ENOENT but stops descending', async () => {
    const deps = makeDeps({ '/': ['/ghost/'] })
    expect(await walkFind(ROOT, deps)).toEqual(['/ghost'])
  })

  it('propagates non-ENOENT stat errors from the dir-classification fallback', async () => {
    const base = makeDeps({ '/': ['/mystery'] })
    const deps: WalkFindDeps = { ...base, stat: () => Promise.reject(new Error('rate limited')) }
    await expect(walkFind(ROOT, deps, { type: 'f' })).rejects.toThrow('rate limited')
  })

  it('propagates non-ENOENT stat errors during size filtering', async () => {
    const base = makeDeps({ '/': ['/a.json'] })
    const deps: WalkFindDeps = {
      ...base,
      isDirName: () => false,
      stat: () => Promise.reject(new Error('rate limited')),
    }
    await expect(walkFind(ROOT, deps, { minSize: 1 })).rejects.toThrow('rate limited')
  })

  it('drops entries whose stat raises ENOENT during size filtering', async () => {
    const base = makeDeps({ '/': ['/a.json'] })
    const deps: WalkFindDeps = { ...base, isDirName: () => false }
    expect(await walkFind(ROOT, deps, { minSize: 1 })).toEqual([])
  })
})

describe('modifiedTs', () => {
  it('returns null for empty or unparseable values', () => {
    expect(modifiedTs(null)).toBeNull()
    expect(modifiedTs('')).toBeNull()
    expect(modifiedTs('not-a-date')).toBeNull()
  })

  it('treats naive datetimes and bare dates as UTC', () => {
    expect(modifiedTs('2026-01-05T06:00:00')).toBe(Date.parse('2026-01-05T06:00:00Z') / 1000)
    expect(modifiedTs('2026-01-05')).toBe(Date.parse('2026-01-05T00:00:00Z') / 1000)
  })

  it('preserves explicit timezone offsets', () => {
    expect(modifiedTs('2026-01-05T00:00:00Z')).toBe(Date.parse('2026-01-05T00:00:00Z') / 1000)
    expect(modifiedTs('2026-01-05T02:00:00+02:00')).toBe(Date.parse('2026-01-05T00:00:00Z') / 1000)
    expect(modifiedTs('2026-01-05T02:00:00+0200')).toBe(Date.parse('2026-01-05T00:00:00Z') / 1000)
  })
})

describe('isEnoent', () => {
  it('matches only ENOENT-coded errors', () => {
    expect(isEnoent(enoent('/x'))).toBe(true)
    expect(isEnoent(new Error('ENOENT: /x'))).toBe(false)
    expect(isEnoent('ENOENT')).toBe(false)
    expect(isEnoent(null)).toBe(false)
  })
})
