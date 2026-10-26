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

import type { ByteSource } from '../../../io/types.ts'
import { describe, expect, it } from 'vitest'
import type { Handed } from '../../../vfs/types.ts'
import { enotdir, enotsup, walkDeclined } from '../../../errors/fs.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import type { MountView } from '../../../view/types.ts'
import { WalkBudget, treeWalk } from './tree.ts'

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
  walk() {
    return treeWalk<string[], FileStat>(this.readTree, this.readdir, this.stat)
  }
}

const at = (p: string): PathSpec => PathSpec.fromStrPath(p)

describe('treeWalk', () => {
  it('lists and stats the whole walk from one answer', async () => {
    const mount = new Mount(found())
    const [readdir, stat] = mount.walk()
    expect(await readdir(at('/m'))).toEqual(['/m/a', '/m/b.txt', '/m/e'])
    expect(await readdir(at('/m/a'))).toEqual(['/m/a/c.txt'])
    expect(await readdir(at('/m/e'))).toEqual([])
    const implied = await stat(at('/m/a'))
    expect([implied.name, implied.type]).toEqual(['a', DIR])
    expect((await stat(at('/m/a/c.txt'))).size).toBe(3)
    expect(mount.asked).toEqual(['/m'])
    expect(mount.calls).toEqual([])
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
    // A subtree read stops at a link at the final name; readdir opens what it
    // leads to.
    ['a link', new Mount(null, (_vfs, _op, path) => enotdir(path))],
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

// A RAM mount that refuses every full walk, keeping its reads. Twin of
// Python's GuardedRAM.
class GuardedRAM extends RAMVFS {
  readonly scans: string[] = []
  readonly reads: string[] = []

  override read(
    path: PathSpec,
    handed?: Handed,
    offset?: number,
    size?: number | null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    this.reads.push(path.virtual)
    return super.read(path, handed, offset, size)
  }

  override beforeFullWalk(path: PathSpec, files: number | null): Promise<void> {
    this.scans.push(path.virtual)
    return Promise.reject(new Error(`${String(files)} files in scope, narrow the path`))
  }
}

async function guarded(line: string): Promise<[GuardedRAM, string, string, number]> {
  const vfs = new GuardedRAM()
  for (const dir of ['/d', '/d/sub', '/e']) vfs.store.dirs.add(dir)
  const enc = new TextEncoder()
  vfs.store.files.set('/d/a.txt', enc.encode('ada\n'))
  vfs.store.files.set('/d/sub/b.txt', enc.encode('bob\n'))
  vfs.store.files.set('/e/a.txt', enc.encode('x\n'))
  const ws = new Workspace({ '/g': vfs, '/out': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    const out = await ws.shell(line)
    const dec = new TextDecoder()
    return [vfs, dec.decode(out.stdout), dec.decode(out.stderr), out.exitCode]
  } finally {
    await ws.close()
  }
}

describe('a whole-directory read asks the mount first', () => {
  // Twin of test_a_command_reading_a_whole_directory_asks_first.
  it.each([
    'tar -cf /out/a.tar /g/d',
    'tar -cf - /g/d',
    'zip -qr /out/a.zip /g/d',
    'cp -r /g/d /out/c',
    'cp -r /g/d /g/c',
    'mv /g/d /out/m',
    'diff -r /g/d /g/e',
    'rm -r /g/d',
  ])('%s is refused before it reads', async (line) => {
    const [vfs, , stderr, code] = await guarded(line)
    expect(vfs.scans.length).toBeGreaterThan(0)
    expect(vfs.reads).toEqual([])
    expect(stderr).toBe(`${line.split(' ')[0] ?? ''}: 2 files in scope, narrow the path\n`)
    expect(code).not.toBe(0)
  })

  // Twin of test_a_refused_tree_copy_leaves_the_destination_alone.
  it.each([
    ['printf x > /out/t; cp -rb -T /g/d /out/t; cat /out/t; ls /out', 'xt\n'],
    ['mkdir /out/t; mv -T /g/d /out/t; ls -d /out/t', '/out/t\n'],
    ['rm -rf /g/d; ls /g/d', 'a.txt\nsub\n'],
  ])('%s leaves the destination alone', async (line, out) => {
    const [, stdout, stderr] = await guarded(line)
    expect(stdout).toBe(out)
    expect(stderr).toMatch(/2 files in scope, narrow the path\n$/)
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
    'rg --files --sort path /g/d /out',
  ])('%s asks nothing', async (line) => {
    const [vfs, , stderr, code] = await guarded(line)
    expect([vfs.scans, stderr, code]).toEqual([[], '', 0])
  })

  // Twin of test_a_search_stops_at_the_limit_rather_than_asking.
  it.each(['grep -r ada /g/d', 'rg ada /g/d', 'rg --sort modified ada /g/d /out'])(
    '%s walks without asking',
    async (line) => {
      const [vfs, stdout, stderr, code] = await guarded(line)
      expect([vfs.scans, stdout, stderr, code]).toEqual([[], '/g/d/a.txt:ada\n', '', 0])
    },
  )
})

// The mounts a scan budget charges, each root to its walk_limit.
function limits(table: Record<string, number>): MountView {
  const rootOf = (path: string): string =>
    Object.keys(table)
      .filter((root) => `${path.replace(/\/+$/, '')}/`.startsWith(root))
      .reduce((a, b) => (b.length > a.length ? b : a), '')
  return {
    descendants: () => [],
    visibleDescendants: () => [],
    isRoot: () => false,
    rootOf,
    answers: () => false,
    searchable: () => null,
    walkLimit: (path) => table[rootOf(path)] ?? -1,
  }
}

const stop = (n: number): string => `stopped after ${String(n)} files (walk_limit); narrow the path`

// Twins of the scan budget tests in test_tree.py.
describe('WalkBudget', () => {
  it('stops once spent and opens nothing more', () => {
    const budget = new WalkBudget(at('/m/d'), limits({ '/m/': 2 }))
    expect([0, 1, 2].map(() => budget.spend('/m/d'))).toEqual([true, true, false])
    expect(budget.opens('/m/d/sub')).toBe(false)
    expect(budget.stopped).toEqual([`/m/d: ${stop(2)}`])
  })

  it('charges each mount under its own root', () => {
    const budget = new WalkBudget(at('/'), limits({ '/': -1, '/m/': 2, '/n/': 3 }))
    expect(Array.from({ length: 50 }, () => budget.spend('/')).every(Boolean)).toBe(true)
    expect([0, 1, 2].map(() => budget.spend('/m/d'))).toEqual([true, true, false])
    expect([0, 1, 2].map(() => budget.spend('/n')).every(Boolean)).toBe(true)
    expect(budget.stopped).toEqual([`/m: ${stop(2)}`])
  })

  it.each([
    ['d', 'd'],
    ['', '.'],
  ])('names the operand as typed (%j)', (raw, shown) => {
    const operand = new PathSpec({
      virtual: '/m/d',
      directory: '/m/d',
      vfsPath: 'm/d',
      rawPath: raw,
    })
    const budget = new WalkBudget(operand, limits({ '/m/': 0 }))
    expect(budget.spend('/m/d')).toBe(false)
    expect(budget.stopped).toEqual([`${shown}: ${stop(0)}`])
  })

  it('cuts one listing and skips the next', async () => {
    const asked: [string, number | undefined][] = []
    const readdir = (path: PathSpec, _nofollow?: boolean, limit?: number): Promise<string[]> => {
      asked.push([path.virtual, limit])
      return Promise.resolve([0, 1, 2].map((i) => `${path.virtual}/${String(i)}`))
    }
    const budget = new WalkBudget(at('/m'), limits({ '/m/': 2 }))
    expect(await budget.listing(readdir, at('/m'))).toEqual(['/m/0', '/m/1'])
    expect(await budget.listing(readdir, at('/m/0'))).toEqual([])
    expect(asked).toEqual([['/m', 3]])
    expect(budget.stopped).toEqual([`/m: ${stop(2)}`])
  })
})
