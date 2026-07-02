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
import { describe, expect, it, vi } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { NotionStatAccessor } from './stat.ts'

const DIRS = new Set(['/db', '/db/sub'])
const FILES: Record<string, number> = {
  '/db/page1.md': 10,
  '/db/sub/page2.md': 20,
}
const CHILDREN: Record<string, string[]> = {
  '/db': ['/db/page1.md', '/db/sub'],
  '/db/sub': ['/db/sub/page2.md'],
}

function normalize(p: PathSpec): string {
  const stripped = stripSlash(p.virtual)
  return stripped !== '' ? `/${stripped}` : '/'
}

vi.mock('./readdir.ts', () => ({
  readdir: (_accessor: unknown, path: PathSpec) => Promise.resolve(CHILDREN[normalize(path)] ?? []),
}))

vi.mock('./stat.ts', () => ({
  stat: (_accessor: unknown, path: PathSpec) => {
    const key = normalize(path)
    const name = key.split('/').pop() ?? '/'
    if (DIRS.has(key)) {
      return Promise.resolve(
        new FileStat({ name: name !== '' ? name : '/', type: FileType.DIRECTORY }),
      )
    }
    return Promise.resolve(new FileStat({ name, type: FileType.TEXT, size: FILES[key] ?? null }))
  },
}))

const { find } = await import('./find.ts')

const accessor = {
  transport: { callTool: () => Promise.reject(new Error('unused')) },
} as NotionStatAccessor

function root(): PathSpec {
  return new PathSpec({
    virtual: '/db',
    directory: '/db',
    resolved: false,
    resourcePath: 'db',
  })
}

describe('notion core find', () => {
  it('finds everything under the root', async () => {
    const out = await find(accessor, root())
    expect(out).toEqual(['/db', '/db/page1.md', '/db/sub', '/db/sub/page2.md'])
  })

  it('matches the mount root by its own basename', async () => {
    const spec = new PathSpec({
      virtual: '/db',
      directory: '/db',
      resolved: false,
      resourcePath: mountKey('/db', '/db'),
    })
    const out = await find(accessor, spec, { name: 'db' })
    expect(out).toEqual(['/'])
  })

  it('filters to files with type f', async () => {
    const out = await find(accessor, root(), { type: 'f' })
    expect(out).toEqual(['/db/page1.md', '/db/sub/page2.md'])
  })

  it('filters to directories with type d', async () => {
    const out = await find(accessor, root(), { type: 'd' })
    expect(out).toEqual(['/db', '/db/sub'])
  })

  it('matches names by glob', async () => {
    const out = await find(accessor, root(), { name: '*.md' })
    expect(out).toEqual(['/db/page1.md', '/db/sub/page2.md'])
  })

  it('limits depth with maxDepth', async () => {
    const out = await find(accessor, root(), { maxDepth: 1 })
    expect(out).toEqual(['/db', '/db/page1.md', '/db/sub'])
  })

  it('skips shallow entries with minDepth', async () => {
    const out = await find(accessor, root(), { minDepth: 1 })
    expect(out).toEqual(['/db/page1.md', '/db/sub', '/db/sub/page2.md'])
  })

  it('filters files by min size', async () => {
    const out = await find(accessor, root(), { type: 'f', minSize: 15 })
    expect(out).toEqual(['/db/sub/page2.md'])
  })
})
