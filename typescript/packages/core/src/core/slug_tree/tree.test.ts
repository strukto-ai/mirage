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

import type { DirListing } from '../../types.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { gnuBasename } from '../../utils/path.ts'
import { dirRows } from './rows.ts'
import { SlugTree, treeKey } from './tree.ts'

const FILES = new Map([
  ['/guides/quickstart', 5],
  ['/api/reference', 3],
])

function fileRow(path: string, size: number): FileStat {
  return new FileStat({ name: gnuBasename(path), type: FileType.FILE, size })
}

function fakeTree(): { tree: SlugTree<null>; load: ReturnType<typeof vi.fn> } {
  const load = vi.fn((_accessor: null) => Promise.resolve(dirRows(FILES, fileRow)))
  return { tree: new SlugTree<null>(load), load }
}

function pathAt(virtual: string): PathSpec {
  return new PathSpec({ vfsPath: mountKey(virtual, '/knowledge'), virtual, directory: virtual })
}

function names(listing: DirListing): string[] {
  return listing.entries.map((row) => row.name)
}

describe('slug tree readdir', () => {
  it('lists folders and refuses the rest', async () => {
    const { tree } = fakeTree()
    expect(names(await tree.readdir(null, pathAt('/knowledge')))).toEqual(['api', 'guides'])
    expect(names(await tree.readdir(null, pathAt('/knowledge/guides')))).toEqual(['quickstart'])
    await expect(tree.readdir(null, pathAt('/knowledge/nope'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses a file with ENOTDIR naming the path', async () => {
    const { tree } = fakeTree()
    await expect(tree.readdir(null, pathAt('/knowledge/guides/quickstart'))).rejects.toMatchObject({
      code: 'ENOTDIR',
      virtualPath: '/knowledge/guides/quickstart',
    })
  })

  it('seeds every folder below from one fetch', async () => {
    const { tree, load } = fakeTree()
    const listing = await tree.readdir(null, pathAt('/knowledge'))
    expect(load).toHaveBeenCalledTimes(1)
    expect(
      Object.fromEntries([...listing.seeds].map(([key, rows]) => [key, rows.map((r) => r.name)])),
    ).toEqual({ api: ['reference'], guides: ['quickstart'] })
  })
})

describe('treeKey', () => {
  it('maps the mount root and keeps prefixed paths', () => {
    expect(treeKey(pathAt('/knowledge'))).toBe('/')
    expect(treeKey(pathAt('/knowledge/'))).toBe('/')
    expect(treeKey(pathAt('/knowledge/guides/auth.md'))).toBe('/guides/auth.md')
  })

  it('normalizes when no prefix is set', () => {
    const ps = (virtual: string) =>
      new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, '') })
    expect(treeKey(ps('/guides/'))).toBe('/guides')
    expect(treeKey(ps('/'))).toBe('/')
  })

  it('uses the directory for glob patterns', () => {
    const spec = new PathSpec({
      virtual: '/knowledge/guides/*.md',
      directory: '/knowledge/guides/',
      pattern: '*.md',
      resolved: false,
      vfsPath: mountKey('/knowledge/guides/*.md', '/knowledge'),
    })
    expect(treeKey(spec)).toBe('/guides')
  })
})
