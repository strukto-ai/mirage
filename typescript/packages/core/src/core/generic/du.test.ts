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

import { describe, expect, it } from 'vitest'
import { Accessor } from '../../accessor/base.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { makeWalkedDu } from './du.ts'

class FakeAccessor extends Accessor {}

const FILES: Record<string, number> = { '/m/a.txt': 3, '/m/sub/b.txt': 4, '/m/sub/c.txt': 5 }
const DIRS: Record<string, string[]> = {
  '/m': ['/m/sub/', '/m/a.txt'],
  '/m/sub': ['/m/sub/c.txt', '/m/sub/b.txt'],
}

const spec = (virtual: string): PathSpec =>
  new PathSpec({ virtual, directory: virtual, vfsPath: virtual.replace(/^\/m\/?/, '') })

const stat = (_a: FakeAccessor, path: PathSpec): Promise<FileStat> => {
  if (path.virtual in DIRS)
    return Promise.resolve(new FileStat({ name: path.virtual, type: FileType.DIRECTORY }))
  const size = FILES[path.virtual]
  if (size !== undefined)
    return Promise.resolve(new FileStat({ name: path.virtual, type: FileType.FILE, size }))
  return Promise.reject(enoent(path.virtual))
}

const readdir = (_a: FakeAccessor, path: PathSpec): Promise<string[]> =>
  Promise.resolve(DIRS[path.virtual] ?? [])

const accessor = new FakeAccessor()
const du = makeWalkedDu(stat, readdir)

describe('makeWalkedDu', () => {
  it('sizes and lists the subtree, entries in code-point order', async () => {
    expect(await du.size(accessor, spec('/m'))).toBe(12)
    expect(await du.entries(accessor, spec('/m'))).toEqual([
      [
        ['/a.txt', 3],
        ['/sub/b.txt', 4],
        ['/sub/c.txt', 5],
      ],
      12,
    ])
  })

  it('gives a file no entries and its own size', async () => {
    expect(await du.entries(accessor, spec('/m/a.txt'))).toEqual([[], 3])
  })

  it('counts a missing path and a child gone mid-walk as zero', async () => {
    expect(await du.size(accessor, spec('/m/nope'))).toBe(0)
    const ghost = makeWalkedDu(stat, (_a, path) =>
      Promise.resolve([...(DIRS[path.virtual] ?? []), `${path.virtual}/ghost.txt`]),
    )
    expect(await ghost.size(accessor, spec('/m'))).toBe(12)
  })

  it('propagates a failure other than absence', async () => {
    const throttled = makeWalkedDu(stat, () => Promise.reject(new Error('429')))
    await expect(throttled.size(accessor, spec('/m'))).rejects.toThrow('429')
  })
})
