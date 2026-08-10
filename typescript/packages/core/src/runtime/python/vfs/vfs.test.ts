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

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadPyodideRuntime, type PyodideInterface } from '../loader.ts'
import { RuntimeVFS } from '../../vfs.ts'
import { applyMutation, createJournal, type MutationJournal } from './journal.ts'
import { preloadInto } from './preload.ts'
import { MirageFs } from './vfs.ts'
import { MirageFsSeed } from './seed.ts'
import type { BridgeDispatchFn } from '../../types.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

interface Call {
  op: string
  path: string
  bytes?: Uint8Array
}

describe('MirageFs', () => {
  let py: PyodideInterface
  let vfs: RuntimeVFS
  let journal: MutationJournal
  const calls: Call[] = []
  const mounts: string[] = []
  const store = new Map<string, Uint8Array>()
  const unreadable = new Set<string>()
  let counter = 0

  // Mirrors what PyodideRuntime.syncMounts does, including collecting the
  // seed through preloadInto rather than hand-building one, so the tests
  // exercise the real producer of every node they then read. Seeding after
  // the mount is load-bearing (an FSNode copies `mount` from its parent,
  // and Emscripten assigns the root's only once type.mount() returned).
  async function mountPrefix(prefix: string): Promise<void> {
    mounts.push(prefix)
    const seed = new MirageFsSeed()
    await preloadInto(seed, vfs, prefix)
    const mountpoint = prefix.slice(0, -1)
    const fs = new MirageFs(py.FS, py.ERRNO_CODES, journal, mountpoint, (path) => vfs.mountOf(path))
    py.FS.mkdirTree(mountpoint)
    py.FS.mount(fs.type, {}, mountpoint)
    fs.seed(seed)
  }

  // The runtime's post-run drain, applied host-side where awaiting the
  // bridge needs no JSPI.
  async function drain(): Promise<void> {
    for (const mutation of journal.takeMutations()) await applyMutation(vfs, mutation)
  }

  beforeAll(async () => {
    py = await loadPyodideRuntime()
    const dispatch: BridgeDispatchFn = (op, path, bytes, dst) => {
      calls.push(bytes ? { op, path, bytes: new Uint8Array(bytes) } : { op, path })
      if (op === 'READ') {
        if (unreadable.has(path)) return Promise.reject(new Error('backend unavailable'))
        const found = store.get(path)
        if (found === undefined) return Promise.reject(new Error(`no such file: ${path}`))
        return Promise.resolve(found)
      }
      if (op === 'WRITE' && bytes !== undefined) store.set(path, new Uint8Array(bytes))
      if (op === 'APPEND' && bytes !== undefined) {
        const base = store.get(path) ?? new Uint8Array()
        const next = new Uint8Array(base.length + bytes.length)
        next.set(base)
        next.set(bytes, base.length)
        store.set(path, next)
      }
      if (op === 'UNLINK') store.delete(path)
      if (op === 'RENAME' && dst !== undefined) {
        const moved = store.get(path)
        if (moved === undefined) return Promise.reject(new Error(`no such file: ${path}`))
        store.delete(path)
        store.set(dst, moved)
      }
      if (op === 'LIST') {
        return Promise.resolve(
          [...store.keys()]
            .filter((k) => k.startsWith(path))
            .map((k) => ({ path: k, size: store.get(k)?.length ?? 0, isDir: false })),
        )
      }
      return Promise.resolve(undefined)
    }
    vfs = new RuntimeVFS(dispatch, () => mounts)
    journal = createJournal()
  }, 60_000)

  beforeEach(() => {
    calls.length = 0
    mounts.length = 0
    store.clear()
    unreadable.clear()
    journal.takeMutations()
    counter += 1
  })

  function prefix(): string {
    return `/m${String(counter)}/`
  }

  it('serves a seeded file to the guest', async () => {
    const p = prefix()
    store.set(`${p}seed.txt`, enc.encode('ORIGINAL'))
    await mountPrefix(p)
    await py.runPythonAsync(`_out = open('${p}seed.txt').read()`)
    expect(py.globals.get('_out')).toBe('ORIGINAL')
  })

  it('records only the tail for an append, and does not clobber the mount', async () => {
    const p = prefix()
    store.set(`${p}log.txt`, enc.encode('BASE'))
    await mountPrefix(p)
    await py.runPythonAsync(`
with open('${p}log.txt', 'a') as f:
    f.write('+more')
`)
    const mutations = journal.takeMutations()
    expect(mutations).toHaveLength(1)
    const only = mutations[0]
    if (only?.kind !== 'append') throw new Error(`expected an append, got ${String(only?.kind)}`)
    expect(dec.decode(only.bytes)).toBe('+more')
  })

  // The shim this replaced patched builtins.open but never os.open, so a
  // low-level write applied to the guest's memory and was dropped on the
  // floor: exit 0, mount unchanged.
  it('records a low-level os.open write', async () => {
    const p = prefix()
    await mountPrefix(p)
    await py.runPythonAsync(`
import os
fd = os.open('${p}low.txt', os.O_WRONLY | os.O_CREAT)
os.write(fd, b'LOWLEVEL')
os.close(fd)
`)
    await drain()
    expect(dec.decode(store.get(`${p}low.txt`) ?? new Uint8Array())).toBe('LOWLEVEL')
  })

  it('records a bare os.truncate, which opens no handle at all', async () => {
    const p = prefix()
    store.set(`${p}t.txt`, enc.encode('12345678'))
    await mountPrefix(p)
    await py.runPythonAsync(`
import os
os.truncate('${p}t.txt', 3)
`)
    await drain()
    expect(dec.decode(store.get(`${p}t.txt`) ?? new Uint8Array())).toBe('123')
  })

  it('carries a file that is created and never written', async () => {
    const p = prefix()
    await mountPrefix(p)
    await py.runPythonAsync(`
from pathlib import Path
Path('${p}empty.txt').touch()
`)
    await drain()
    expect(store.has(`${p}empty.txt`)).toBe(true)
    expect(store.get(`${p}empty.txt`)?.length).toBe(0)
  })

  it('records a shutil.rmtree in post order, through its fd-relative walk', async () => {
    const p = prefix()
    store.set(`${p}tree/a.txt`, enc.encode('a'))
    store.set(`${p}tree/b/c.txt`, enc.encode('c'))
    await mountPrefix(p)
    await py.runPythonAsync(`
import shutil
shutil.rmtree('${p}tree')
`)
    const kinds = journal.takeMutations().map((m) => `${m.kind} ${m.path.slice(p.length)}`)
    expect(kinds).toEqual([
      'unlink tree/a.txt',
      'unlink tree/b/c.txt',
      'rmdir tree/b',
      'rmdir tree',
    ])
  })

  it('keeps the write-temp-then-rename idiom in order', async () => {
    const p = prefix()
    await mountPrefix(p)
    await py.runPythonAsync(`
import os
with open('${p}tmp.part', 'w') as f:
    f.write('ATOMIC')
os.rename('${p}tmp.part', '${p}final.txt')
`)
    await drain()
    expect(dec.decode(store.get(`${p}final.txt`) ?? new Uint8Array())).toBe('ATOMIC')
    expect(store.has(`${p}tmp.part`)).toBe(false)
  })

  it('refuses a cross-mount rename with a real EXDEV the guest can match', async () => {
    const a = prefix()
    const b = `/other${String(counter)}/`
    store.set(`${a}sub/x.txt`, enc.encode('X'))
    store.set(`${b}sub/y.txt`, enc.encode('Y'))
    await mountPrefix(a)
    await mountPrefix(b)
    // Nested, not top level: a node seeded before its mount is assigned
    // inherits an undefined one, and two undefined mounts compare equal,
    // which silently lets the kernel's cross-mount check through.
    await py.runPythonAsync(`
import errno, os
try:
    os.rename('${a}sub/x.txt', '${b}sub/x.txt')
    _res = 'NO ERROR'
except OSError as e:
    _res = 'EXDEV' if e.errno == errno.EXDEV else f'wrong errno {e.errno}'
`)
    expect(py.globals.get('_res')).toBe('EXDEV')
    expect(journal.takeMutations()).toEqual([])
  })

  it('refuses a rename across a nested mount boundary inside one mountpoint', async () => {
    const p = prefix()
    const nested = `${p}inner/`
    store.set(`${p}x.txt`, enc.encode('X'))
    store.set(`${nested}deep.txt`, enc.encode('D'))
    // The nested prefix is a mirage mount but not an Emscripten one:
    // syncMounts collapses to maximal prefixes, so one mountpoint serves
    // both trees and the kernel's own cross-mount check cannot fire.
    mounts.push(nested)
    await mountPrefix(p)
    await py.runPythonAsync(`
import errno, os
try:
    os.rename('${p}x.txt', '${nested}x.txt')
    _res2 = 'NO ERROR'
except OSError as e:
    _res2 = 'EXDEV' if e.errno == errno.EXDEV else f'wrong errno {e.errno}'
`)
    expect(py.globals.get('_res2')).toBe('EXDEV')
    expect(journal.takeMutations()).toEqual([])
    // The refused source is still readable in place.
    await py.runPythonAsync(`_kept = open('${p}x.txt').read()`)
    expect(py.globals.get('_kept')).toBe('X')
  })

  it('resolves a relative path against the guest cwd', async () => {
    const p = prefix()
    await mountPrefix(p)
    await py.runPythonAsync(`
import os
os.chdir('${p}')
with open('rel.txt', 'w') as f:
    f.write('RELATIVE')
`)
    await drain()
    expect(dec.decode(store.get(`${p}rel.txt`) ?? new Uint8Array())).toBe('RELATIVE')
  })

  it('stops serving a prefix once it is unmounted', async () => {
    const p = prefix()
    store.set(`${p}gone.txt`, enc.encode('here'))
    await mountPrefix(p)
    await py.runPythonAsync(`_before = open('${p}gone.txt').read()`)
    expect(py.globals.get('_before')).toBe('here')
    py.FS.unmount(p.slice(0, -1))
    await py.runPythonAsync(`
import os
_after = os.listdir('${p}')
`)
    expect((py.globals.get('_after') as { length: number }).length).toBe(0)
  })

  it('does not record a write that traverses back out of the mount', async () => {
    const p = prefix()
    await mountPrefix(p)
    // The escape is the kernel's to resolve, not a prefix test of ours:
    // `<mount>/../escaped.txt` never reaches this filesystem at all, so
    // it lands in the guest's own memory and touches no mount.
    await py.runPythonAsync(`
with open('${p}../escaped.txt', 'w') as f:
    f.write('ESCAPED')
`)
    await drain()
    expect([...store.keys()]).toEqual([])
    expect(calls.filter((c) => c.op === 'WRITE')).toEqual([])
  })

  it('refuses to open a listed file the mount would not hand over', async () => {
    const p = prefix()
    // The mount lists it, so it exists; it just will not serve it. The
    // unreadable mark has to come from preloadInto reacting to that, not
    // from the test setting it by hand.
    store.set(`${p}locked.txt`, enc.encode('SECRET'))
    unreadable.add(`${p}locked.txt`)
    await mountPrefix(p)
    await py.runPythonAsync(`
import errno
try:
    open('${p}locked.txt', 'a').write('tail')
    _errno = 0
except OSError as e:
    _errno = e.errno
`)
    // EIO, not ENOENT: absence and unreadable must stay distinguishable,
    // since only absence makes an empty base safe to build a write on.
    expect(py.globals.get('_errno')).toBe(py.ERRNO_CODES.EIO)
    expect(journal.takeMutations()).toEqual([])
  })

  // Filenames are the mount's to choose, so the child table is keyed by a
  // Map. On a plain object these names reach Object.prototype instead of
  // an own property, and the file either vanishes or resolves to junk.
  it('serves files whose names collide with object prototype keys', async () => {
    const p = prefix()
    store.set(`${p}__proto__`, enc.encode('PROTO'))
    store.set(`${p}constructor`, enc.encode('CTOR'))
    await mountPrefix(p)
    await py.runPythonAsync(`
import os
_names = ','.join(sorted(os.listdir('${p}')))
_proto = open('${p}__proto__').read()
_ctor = open('${p}constructor').read()
`)
    expect(py.globals.get('_names')).toBe('__proto__,constructor')
    expect(py.globals.get('_proto')).toBe('PROTO')
    expect(py.globals.get('_ctor')).toBe('CTOR')
  })

  it('reports the seeded size through os.stat', async () => {
    const p = prefix()
    store.set(`${p}sized.txt`, enc.encode('123456789'))
    await mountPrefix(p)
    await py.runPythonAsync(`
import os
_size = os.stat('${p}sized.txt').st_size
`)
    expect(py.globals.get('_size')).toBe(9)
  })
})
