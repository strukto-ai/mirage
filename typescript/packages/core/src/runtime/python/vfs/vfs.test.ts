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
import { PrefixResolver } from '../../resolver.ts'
import { RuntimeVFS } from '../../vfs.ts'
import { applyMutation, createJournal, type MutationJournal } from './journal.ts'
import { preloadInto } from './preload.ts'
import { changedAttrs, MirageFs } from './vfs.ts'
import { MirageFsSeed } from './seed.ts'
import type { BridgeDispatchFn } from '../../types.ts'
import type { FSNode } from './types.ts'
import { ContentType, FileStat, FileType, type SetAttrFields } from '../../../types.ts'

const enc = new TextEncoder()

// The mount's own metadata, which the tree has no way to invent.
const STORE_MODE = 0o660
const STORE_MTIME = '2026-07-15T00:00:00Z'
const STORE_MTIME_S = 1784073600
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
  const links = new Map<string, string>()
  const attrs: [string, SetAttrFields][] = []
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
    const dispatch: BridgeDispatchFn = (op, path, bytes, dst, fields) => {
      calls.push(bytes ? { op, path, bytes: new Uint8Array(bytes) } : { op, path })
      if (op === 'read') {
        if (unreadable.has(path)) return Promise.reject(new Error('backend unavailable'))
        const found = store.get(path)
        if (found === undefined) return Promise.reject(new Error(`no such file: ${path}`))
        return Promise.resolve(found)
      }
      if (op === 'write' && bytes !== undefined) store.set(path, new Uint8Array(bytes))
      if (op === 'append' && bytes !== undefined) {
        const base = store.get(path) ?? new Uint8Array()
        const next = new Uint8Array(base.length + bytes.length)
        next.set(base)
        next.set(bytes, base.length)
        store.set(path, next)
      }
      if (op === 'unlink') store.delete(path)
      if (op === 'rename' && dst !== undefined) {
        const moved = store.get(path)
        if (moved === undefined) return Promise.reject(new Error(`no such file: ${path}`))
        store.delete(path)
        store.set(dst, moved)
      }
      if (op === 'readdir') {
        const listed = [...store.keys(), ...links.keys()].filter((k) => k.startsWith(path))
        return Promise.resolve(listed)
      }
      if (op === 'stat') {
        const found = store.get(path)
        if (found === undefined) {
          // A link, whose mark rides the resolver, or a path that went
          // away between the listing and the stat.
          return Promise.reject(
            Object.assign(new Error(`no such file: ${path}`), {
              code: 'ENOENT',
            }),
          )
        }
        return Promise.resolve(
          new FileStat({
            name: path,
            size: found.length,
            type: FileType.FILE,
            content: ContentType.TEXT,
            // Deliberately not the tree's own defaults, so a test can
            // tell which of the two a guest's stat answered from.
            mode: STORE_MODE,
            modified: STORE_MTIME,
          }),
        )
      }
      if (op === 'symlink' && dst !== undefined) links.set(path, dst)
      if (op === 'readlink') {
        const target = links.get(path)
        if (target === undefined) return Promise.reject(new Error(`not a link: ${path}`))
        return Promise.resolve(target)
      }
      if (op === 'setattr' && fields !== undefined) attrs.push([path, fields])
      return Promise.resolve(undefined)
    }
    // The link source is the double's own name plane, which is what a
    // workspace hands its runtimes: link names per directory.
    vfs = new RuntimeVFS(
      dispatch,
      new PrefixResolver(
        () => mounts,
        (directory) =>
          new Set(
            [...links.keys()]
              .filter((k) => k.startsWith(directory) && !k.slice(directory.length).includes('/'))
              .map((k) => k.slice(directory.length)),
          ),
      ),
    )
    journal = createJournal()
  }, 60_000)

  beforeEach(() => {
    calls.length = 0
    mounts.length = 0
    store.clear()
    unreadable.clear()
    links.clear()
    attrs.length = 0
    journal.takeMutations()
    counter += 1
  })

  function prefix(): string {
    return `/m${String(counter)}/`
  }

  // Emscripten's MEMFS makes /dev/stdin, /dev/stdout and /dev/stderr at
  // startup, and pyodide's own capture reopens /dev/stderr when a run ends.
  // Mounting mirage's /dev over MEMFS's used to hide them, and that reopen
  // threw ENOENT out of a callback nobody catches: an unhandled rejection,
  // which Node turns into a dead process.
  it('keeps the standard stream devices when it takes over /dev', async () => {
    await mountPrefix('/dev/')
    const fs = py.FS as unknown as {
      stat: (p: string) => { mode: number }
      open: (p: string, flags: string) => unknown
      readFile: (p: string) => Uint8Array
      createDevice: (dir: string, name: string, i?: unknown, o?: unknown) => unknown
      chmod: (p: string, m: number) => void
    }
    for (const name of ['stdin', 'stdout', 'stderr']) {
      expect((fs.stat(`/dev/${name}`).mode & 0o170000) === 0o020000).toBe(true)
    }
    // The reopen itself, which is the call that used to throw.
    expect(fs.open('/dev/stderr', 'w')).toBeTruthy()
    // And they have to read as empty. A character device here answers with an
    // endless run of zeroes unless told otherwise, which is /dev/zero's job; a
    // stream doing the same would hang `open('/dev/stdin').read()` forever
    // rather than reach EOF.
    for (const name of ['stdin', 'stdout', 'stderr']) {
      expect(fs.readFile(`/dev/${name}`).length).toBe(0)
    }
    // And nothing about a device reaches the journal. pyodide makes one at
    // runtime (API.capture_stderr calls FS.createDevice) and chmods it right
    // after; replaying either wrote a device path against the real mount,
    // which is what failed during teardown.
    fs.createDevice('/dev', 'probe_dev', undefined, () => true)
    fs.chmod('/dev/probe_dev', 0o600)
    const touched = journal.takeMutations().map((m) => m.path)
    expect(touched.filter((path) => path.includes('probe_dev'))).toEqual([])
  })

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
    expect(calls.filter((c) => c.op === 'write')).toEqual([])
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

  // Both come off the row the preload already had. Before this the node
  // carried makeNode's defaults, so a chmod the shell made was invisible
  // and every seeded file looked modified the moment the run started.
  it('reports the mount mode and stamp through os.stat', async () => {
    const p = prefix()
    store.set(`${p}meta.txt`, enc.encode('abc'))
    await mountPrefix(p)
    await py.runPythonAsync(`
import os, stat
_st = os.stat('${p}meta.txt')
_mode = stat.S_IMODE(_st.st_mode)
_mtime = int(_st.st_mtime)
_isreg = stat.S_ISREG(_st.st_mode)
`)
    expect(py.globals.get('_mode')).toBe(STORE_MODE)
    expect(py.globals.get('_mtime')).toBe(STORE_MTIME_S)
    expect(py.globals.get('_isreg')).toBe(true)
  })

  // A link is namespace state, so the mount that gets it need not be
  // able to store one: the op reaches the node table. Before this the
  // callback refused with EPERM, which is what MEMFS-backed pyodide
  // guests had to work around.
  it('creates a symlink the guest asked for', async () => {
    const p = prefix()
    store.set(`${p}t.txt`, enc.encode('TARGET'))
    await mountPrefix(p)
    await py.runPythonAsync(`
import os
os.symlink('t.txt', '${p}link')
_is = os.path.islink('${p}link')
_target = os.readlink('${p}link')
`)
    expect(py.globals.get('_is')).toBe(true)
    expect(py.globals.get('_target')).toBe('t.txt')
    await drain()
    expect(links.get(`${p}link`)).toBe('t.txt')
  })

  // lstat sizes a link at its target string, which is what every POSIX
  // system reports and what the mount's own row says.
  it('lstats a created link as a link', async () => {
    const p = prefix()
    await mountPrefix(p)
    await py.runPythonAsync(`
import os, stat
os.symlink('some/where', '${p}l')
_st = os.lstat('${p}l')
_islnk = stat.S_ISLNK(_st.st_mode)
_size = _st.st_size
`)
    expect(py.globals.get('_islnk')).toBe(true)
    expect(py.globals.get('_size')).toBe('some/where'.length)
  })

  // The seed carries links now, so one the shell made is visible to the
  // guest instead of missing: preload used to skip every link entry.
  it('serves a seeded link to the guest', async () => {
    const p = prefix()
    store.set(`${p}real.txt`, enc.encode('CONTENT'))
    links.set(`${p}seeded`, 'real.txt')
    await mountPrefix(p)
    await py.runPythonAsync(`
import os
_is = os.path.islink('${p}seeded')
_target = os.readlink('${p}seeded')
`)
    expect(py.globals.get('_is')).toBe(true)
    expect(py.globals.get('_target')).toBe('real.txt')
  })

  it('refuses readlink on a path that is not a link', async () => {
    const p = prefix()
    store.set(`${p}plain.txt`, enc.encode('x'))
    await mountPrefix(p)
    await py.runPythonAsync(`
import errno, os
try:
    os.readlink('${p}plain.txt')
    _errno = 0
except OSError as exc:
    _errno = exc.errno
_einval = errno.EINVAL
`)
    expect(py.globals.get('_errno')).toBe(py.globals.get('_einval'))
  })

  // A guest utime reached only the private node table before this, so a
  // stamp the script wrote vanished with the run.
  it('sends a guest utime to the mount', async () => {
    const p = prefix()
    store.set(`${p}stamped.txt`, enc.encode('x'))
    await mountPrefix(p)
    await py.runPythonAsync(`
import os
os.utime('${p}stamped.txt', (100.0, 200.0))
`)
    await drain()
    expect(attrs).toEqual([
      [`${p}stamped.txt`, { atime: '1970-01-01T00:01:40Z', mtime: '1970-01-01T00:03:20Z' }],
    ])
  })

  // A truncating open reaches setattr too (Emscripten routes the resize
  // through it), and that must not turn into a metadata write the guest
  // never asked for: the bytes are the mutation, the stamp is not.
  it('does not journal a metadata write for a truncating open', async () => {
    const p = prefix()
    store.set(`${p}w.txt`, enc.encode('OLD'))
    await mountPrefix(p)
    await py.runPythonAsync(`
f = open('${p}w.txt', 'w')
f.write('NEW')
f.close()
`)
    await drain()
    expect(attrs.map(([path]) => path)).toEqual([])
  })

  // Emscripten finalizes a new file with a chmod of its own, on the same
  // callback a guest's chmod arrives on. Journaling it would send a
  // metadata write nobody asked for, store the filesystem's default mode
  // over the mount's, and split the two coalesced writes a create makes.
  it('does not journal a metadata write for a created file', async () => {
    const p = prefix()
    await mountPrefix(p)
    await py.runPythonAsync(`
f = open('${p}fresh.txt', 'wb')
f.write(b'hi')
f.close()
`)
    await drain()
    expect(attrs).toEqual([])
    expect(dec.decode(store.get(`${p}fresh.txt`))).toBe('hi')
  })

  // The marker that suppresses the create's own chmod must not swallow
  // the guest's next one.
  it('still sends a chmod made right after a create', async () => {
    const p = prefix()
    await mountPrefix(p)
    await py.runPythonAsync(`
import os
open('${p}made.txt', 'wb').close()
os.chmod('${p}made.txt', 0o640)
`)
    await drain()
    expect(attrs).toEqual([[`${p}made.txt`, { mode: 0o640 }]])
  })

  it('sends a guest chmod to the mount as permission bits', async () => {
    const p = prefix()
    store.set(`${p}moded.txt`, enc.encode('x'))
    await mountPrefix(p)
    await py.runPythonAsync(`
import os
os.chmod('${p}moded.txt', 0o600)
`)
    await drain()
    expect(attrs).toEqual([[`${p}moded.txt`, { mode: 0o600 }]])
  })
})

// The comparison half of the same decision: Emscripten bumps a stamp on
// writes that change nothing, and a mount should not hear about those.
describe('changedAttrs', () => {
  const nodeAt = (mode: number, atime: number, mtime: number): FSNode =>
    ({ mode, atime, mtime }) as FSNode

  it('answers null when nothing moved', () => {
    const node = nodeAt(0o100644, 1000, 2000)
    expect(changedAttrs(node, { mode: 0o100644, atime: 1000, mtime: 2000 })).toBeNull()
  })

  it('reports permission bits only, without the type bits', () => {
    const node = nodeAt(0o100644, 0, 0)
    expect(changedAttrs(node, { mode: 0o100600 })).toEqual({ mode: 0o600 })
  })

  it('renders each stamp as ISO from epoch milliseconds', () => {
    const node = nodeAt(0o100644, 0, 0)
    expect(changedAttrs(node, { atime: 100_000, mtime: 200_000 })).toEqual({
      atime: '1970-01-01T00:01:40Z',
      mtime: '1970-01-01T00:03:20Z',
    })
  })

  // No POSIX call sets ctime, so a mount has nothing to write it to.
  it('never reports ctime, and never reports size as metadata', () => {
    const node = nodeAt(0o100644, 0, 0)
    expect(changedAttrs(node, { ctime: 5, size: 9 })).toBeNull()
  })
})
