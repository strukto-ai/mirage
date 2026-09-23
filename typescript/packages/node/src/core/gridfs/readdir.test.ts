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
  return { ...actual, iterLatest: vi.fn(), filesColl: vi.fn(), latestFile: vi.fn() }
})

import { PathSpec } from '@struktoai/mirage-core/types'
import { GridFSAccessor } from '../../accessor/gridfs.ts'
import type { GridFSConfig } from '../../vfs/gridfs/config.ts'
import type { GridFSFileDoc } from './client.ts'
import * as clientMod from './client.ts'
import { readdir } from './readdir.ts'

const TREE = ['a.txt', 'dir/f.txt', 'dir/sub/g.txt', 'empty/']

function doc(filename: string): GridFSFileDoc {
  return { filename, _id: filename, length: 1, uploadDate: new Date(0) } as unknown as GridFSFileDoc
}

function selects(query: Record<string, unknown>, name: string): boolean {
  const filename = query.filename
  if (filename === undefined) return true
  if (typeof filename === 'string') return filename === name
  return new RegExp((filename as { $regex: string }).$regex).test(name)
}

function mockBucket(names: string[]): void {
  vi.mocked(clientMod.iterLatest).mockImplementation(
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* (_accessor, query): AsyncGenerator<GridFSFileDoc> {
      for (const name of names) {
        if (selects(query, name)) yield doc(name)
      }
    },
  )
  vi.mocked(clientMod.filesColl).mockResolvedValue({
    findOne: (query: Record<string, unknown>) =>
      Promise.resolve(names.some((n) => selects(query, n)) ? { _id: 'x' } : null),
  } as never)
  // The driver's head probe resolves through latestFile, the same seam the
  // python tests patch on mirage.core.gridfs.driver.
  vi.mocked(clientMod.latestFile).mockImplementation((_accessor, key) =>
    Promise.resolve(names.includes(key) ? doc(key) : null),
  )
}

function spec(virtual: string): PathSpec {
  return new PathSpec({
    vfsPath: virtual.replace(/^\/+|\/+$/g, ''),
    virtual,
    directory: virtual,
  })
}

function run(names: string[], virtual: string, keyPrefix?: string): Promise<string[]> {
  mockBucket(names)
  const config = { uri: 'mongodb://x', database: 'db', bucket: 'data', keyPrefix } as GridFSConfig
  return readdir(new GridFSAccessor(config), spec(virtual))
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-code'
  }
  return 'no-throw'
}

describe('gridfs core readdir', () => {
  beforeEach(() => {
    vi.mocked(clientMod.iterLatest).mockReset()
    vi.mocked(clientMod.filesColl).mockReset()
    vi.mocked(clientMod.latestFile).mockReset()
  })

  it('lists a prefix', async () => {
    await expect(run(TREE, '/dir')).resolves.toEqual(['/dir/f.txt', '/dir/sub'])
  })

  it('reads a marker-only directory as empty, not missing', async () => {
    // The zero-length "empty/" marker doc is the only trace an empty
    // directory leaves, and it must read as an empty listing, not ENOENT.
    await expect(run(TREE, '/empty')).resolves.toEqual([])
  })

  it('does not raise on the root of an empty bucket', async () => {
    await expect(run([], '/')).resolves.toEqual([])
  })

  it('reports ENOENT for a missing path', async () => {
    await expect(codeOf(run(TREE, '/never.txt'))).resolves.toBe('ENOENT')
  })

  it('reports ENOENT for a missing nested path', async () => {
    await expect(codeOf(run(TREE, '/nodir/deep'))).resolves.toBe('ENOENT')
  })

  it('reports ENOTDIR on a file doc', async () => {
    await expect(codeOf(run(TREE, '/a.txt'))).resolves.toBe('ENOTDIR')
  })

  it('reports ENOTDIR below a file doc', async () => {
    await expect(codeOf(run(TREE, '/a.txt/x'))).resolves.toBe('ENOTDIR')
  })

  it('reports ENOENT for a missing path under a key prefix', async () => {
    await expect(codeOf(run(['team/dir/f.txt'], '/never.txt', 'team/'))).resolves.toBe('ENOENT')
  })

  it('reports ENOENT for a missing child of a coexisting doc and prefix', async () => {
    // GridFS allows a file "a" and deeper files under "a/" at once, and a
    // child path reaches "a" only through the prefix, so a missing child is
    // ENOENT rather than ENOTDIR.
    await expect(codeOf(run(['a', 'a/x.txt'], '/a/never'))).resolves.toBe('ENOENT')
  })

  it('still lists the children of a coexisting prefix', async () => {
    await expect(run(['a', 'a/x.txt'], '/a')).resolves.toEqual(['/a/x.txt'])
  })
})
