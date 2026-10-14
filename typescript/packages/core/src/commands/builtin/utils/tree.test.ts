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
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { enotsup, walkDeclined } from '../../../errors/fs.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
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

// A RAM mount that refuses every full scan, keeping its reads. Twin of
// Python's GuardedRAM.
class GuardedRAM extends RAMVFS {
  readonly scans: string[] = []
  readonly reads: string[] = []

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset?: number,
    size?: number | null,
  ): Promise<Uint8Array> {
    this.reads.push(path.virtual)
    return super.read(path, index, offset, size)
  }

  override readStream(path: PathSpec, index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    this.reads.push(path.virtual)
    return super.readStream(path, index)
  }

  override beforeFullScan(path: PathSpec, files: number | null): Promise<void> {
    this.scans.push(path.virtual)
    return Promise.reject(new Error(`${String(files)} files in scope, narrow the path`))
  }
}

async function guarded(line: string): Promise<[GuardedRAM, string, number]> {
  const vfs = new GuardedRAM()
  for (const dir of ['/d', '/d/sub', '/e']) vfs.store.dirs.add(dir)
  const enc = new TextEncoder()
  vfs.store.files.set('/d/a.txt', enc.encode('ada\n'))
  vfs.store.files.set('/d/sub/b.txt', enc.encode('bob\n'))
  vfs.store.files.set('/e/a.txt', enc.encode('x\n'))
  const ws = new Workspace(
    { '/g': vfs, '/out': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    const out = await ws.shell(line)
    return [vfs, new TextDecoder().decode(out.stderr), out.exitCode]
  } finally {
    await ws.close()
  }
}

describe('a whole-directory read asks the mount first', () => {
  // Twin of test_a_command_reading_a_whole_directory_asks_first.
  it.each([
    'grep -r ada /g/d',
    'rg ada /g/d',
    'rg --sort modified ada /g/d /out',
    'tar -cf /out/a.tar /g/d',
    'tar -cf - /g/d',
    'zip -qr /out/a.zip /g/d',
    'cp -r /g/d /out/c',
    'cp -r /g/d /g/c',
    'mv /g/d /out/m',
    'diff -r /g/d /g/e',
  ])('%s is refused before it reads', async (line) => {
    const [vfs, stderr, code] = await guarded(line)
    expect(vfs.scans.length).toBeGreaterThan(0)
    expect(vfs.reads).toEqual([])
    expect(stderr).toBe(`${line.split(' ')[0] ?? ''}: 2 files in scope, narrow the path\n`)
    expect(code).not.toBe(0)
  })

  // Twin of test_a_command_reading_named_files_asks_nothing.
  it.each([
    'cat /g/d/a.txt',
    'find /g/d',
    'ls -R /g/d',
    'du -a /g/d',
    'cp /g/d/a.txt /out/a.txt',
    'zip -q /out/a.zip /g/d/a.txt',
    'grep ada /g/d/a.txt',
  ])('%s asks nothing', async (line) => {
    const [vfs, stderr, code] = await guarded(line)
    expect([vfs.scans, stderr, code]).toEqual([[], '', 0])
  })
})
