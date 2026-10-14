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
import { enotsup, walkDeclined } from '../../../errors/fs.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { treeWalk } from './tree.ts'

const FILE = FileType.FILE
const DIR = FileType.DIRECTORY

function found(): Map<string, FileStat> {
  return new Map([
    ['b.txt', new FileStat({ name: 'b.txt', type: FILE, size: 2 })],
    ['a/c.txt', new FileStat({ name: 'c.txt', type: FILE, size: 3 })],
    ['e', new FileStat({ name: 'e', type: DIR })],
  ])
}

// Mirrors test_tree.py.
class Mount {
  readonly asked: string[] = []
  readonly calls: string[] = []
  constructor(
    readonly answer: Map<string, FileStat> | null = null,
    readonly refuse?: (vfs: string, op: string, path: PathSpec) => Error,
  ) {}
  readTree = (path: PathSpec): Promise<Map<string, FileStat> | null> => {
    this.asked.push(path.virtual)
    if (this.refuse !== undefined) return Promise.reject(this.refuse('ram', 'read_tree', path))
    return Promise.resolve(this.answer)
  }
  readdir = (path: PathSpec): Promise<string[]> => {
    this.calls.push(`readdir ${path.virtual}`)
    return Promise.resolve([])
  }
  stat = (path: PathSpec): Promise<FileStat> => {
    this.calls.push(`stat ${path.virtual}`)
    return Promise.resolve(new FileStat({ name: path.virtual, type: FILE }))
  }
  walk(answered?: Set<string>) {
    return treeWalk<string[], FileStat>(this.readTree, this.readdir, this.stat, answered)
  }
}

const at = (p: string): PathSpec => PathSpec.fromStrPath(p)

describe('treeWalk', () => {
  it('lists and stats the whole walk from one answer', async () => {
    const mount = new Mount(found())
    const answered = new Set<string>()
    const [readdir, stat] = mount.walk(answered)
    expect(await readdir(at('/m'))).toEqual(['/m/a', '/m/b.txt', '/m/e'])
    expect(await readdir(at('/m/a'))).toEqual(['/m/a/c.txt'])
    expect(await readdir(at('/m/e'))).toEqual([])
    const implied = await stat(at('/m/a'))
    expect([implied.name, implied.type]).toEqual(['a', DIR])
    expect((await stat(at('/m/a/c.txt'))).size).toBe(3)
    expect(mount.asked).toEqual(['/m'])
    expect(mount.calls).toEqual([])
    expect([...answered].sort()).toEqual(['/m', '/m/a', '/m/e'])
  })

  // Mirrors test_a_dotted_or_refused_operand_is_never_answered_from_an_earlier_answer.
  it('never answers a dotted or refused operand from an earlier answer', async () => {
    const mount = new Mount(found())
    const [readdir, stat] = mount.walk()
    await readdir(at('/m'))
    const dotted = PathSpec.fromStrPath('/m/x/../a', undefined, '/')
    await stat(dotted)
    await readdir(dotted)
    const refused = new PathSpec({
      virtual: '/m/e',
      directory: '/m/',
      vfsPath: 'm/e',
      walkError: 'ENOENT',
    })
    await stat(refused)
    await readdir(refused)
    expect(mount.asked).toEqual(['/m', '/m/a', '/m/e'])
    expect(mount.calls).toEqual(['stat /m/a', 'stat /m/e'])
  })

  it('lists in code point order', async () => {
    const names = ['\u{1f600}.txt', '\ue000.txt']
    const mount = new Mount(
      new Map(names.map((n) => [n, new FileStat({ name: n, type: FILE, size: 1 })])),
    )
    const [readdir] = mount.walk()
    expect(await readdir(at('/m'))).toEqual(['/m/\ue000.txt', '/m/\u{1f600}.txt'])
  })

  it('sends the root and paths the answer lacks to the mount', async () => {
    const mount = new Mount(found())
    const [readdir, stat] = mount.walk()
    await readdir(at('/m'))
    await stat(at('/m'))
    await stat(at('/m/zz'))
    expect(mount.calls).toEqual(['stat /m', 'stat /m/zz'])
  })

  it.each([
    ['none', new Mount(null)],
    ['declined', new Mount(null, walkDeclined)],
  ])('walks the usual way with %s and asks once', async (_label, mount) => {
    const [readdir] = mount.walk()
    for (let i = 0; i < 2; i++) await readdir(at('/m'))
    expect(mount.calls).toEqual(['readdir /m', 'readdir /m'])
    expect(mount.asked).toEqual(['/m'])
  })

  it("propagates a backend's own refusal", async () => {
    const [readdir] = new Mount(null, enotsup).walk()
    await expect(readdir(at('/m'))).rejects.toMatchObject({ code: 'ENOTSUP' })
  })

  it('hands back the walk without a readTree', () => {
    const mount = new Mount()
    expect(treeWalk(undefined, mount.readdir, mount.stat)).toEqual([mount.readdir, mount.stat])
  })
})
