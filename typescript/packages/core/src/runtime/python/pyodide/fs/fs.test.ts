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
import { PrefixResolver } from '../../../resolver.ts'
import { RuntimeFiles } from '../../../files.ts'
import {
  applyMutation,
  createJournal,
  type MirageMutation,
  type MutationJournal,
} from './journal.ts'
import { changedAttrs, PyodideFs } from './fs.ts'
import type { BridgeDispatchFn, VFSEntry, VFSStat } from '../../../types.ts'
import { DIR_MODE, FILE_MODE } from './constants.ts'
import type { FSNode, SyncVFS } from './types.ts'
import { ContentType, FileStat, FileType, type SetAttrFields } from '../../../../types.ts'
import { overlaid } from '../../../handles/file_handle.ts'
import type { OpenMode } from '../../../handles/mode.ts'

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

// One handle of the double's open-file core: the file as its open found
// it, and what it wrote since.
interface Held {
  path: string
  mode: OpenMode
  row: VFSStat
  data: Uint8Array
  writes: [number, Uint8Array][]
}

type HandleOps = Pick<SyncVFS, 'open' | 'pread' | 'pwrite' | 'fstat' | 'ftruncate' | 'close'>

describe('PyodideFs', () => {
  let py: PyodideInterface
  let files: RuntimeFiles
  let journal: MutationJournal
  const calls: Call[] = []
  const mounts: string[] = []
  const store = new Map<string, Uint8Array>()
  const links = new Map<string, string>()
  const attrs: [string, SetAttrFields][] = []
  const flushed: MirageMutation[] = []
  const held = new Map<number, Held>()
  const opened: [string, OpenMode][] = []
  let nextHandle = 0
  // The test mount's store, answered synchronously: the bridge wraps it in
  // a promise, and the worker double's flush calls it directly, as the
  // host applies what a worker flushes before it answers.
  let serve: (...args: Parameters<BridgeDispatchFn>) => unknown
  let counter = 0

  // Mounts as PyodideRuntime.syncMounts does in its worker, over a
  // synchronous view of the same store the bridge serves. What the guest
  // flushes lands on the store at once and is kept, in order, for a test
  // to read back (`recorded`).
  async function mountPrefix(prefix: string): Promise<void> {
    mountOver(prefix, storeSync())
    await Promise.resolve()
  }

  function serveMutation(mutation: MirageMutation): void {
    switch (mutation.kind) {
      case 'truncate':
        serve('truncate', mutation.path, undefined, undefined, { length: mutation.length })
        return
      case 'rename':
        serve('rename', mutation.path, undefined, mutation.dst)
        return
      case 'symlink':
        serve('symlink', mutation.path, undefined, mutation.target)
        return
      case 'setattr':
        serve('setattr', mutation.path, undefined, undefined, mutation.attrs)
        return
      default:
        serve(mutation.kind, mutation.path)
    }
  }

  // Every mutation the guest made, flushed or still journaled, in order.
  function recorded(): MirageMutation[] {
    return [...flushed.splice(0), ...journal.takeMutations()]
  }

  // The run's open-file core as the worker reaches it, over the store: a
  // handle holds the file as its open found it and reads what it wrote
  // over that, and its close lands what it wrote while the file still has
  // its name. What the core itself does with held bytes is its own tests'.
  function handlesOver(stat: (path: string) => VFSStat): HandleOps {
    const of = (fh: number): Held => {
      const found = held.get(fh)
      if (found === undefined) {
        throw Object.assign(new Error(`no handle ${String(fh)}`), { code: 'EBADF' })
      }
      return found
    }
    const bytes = (h: Held): Uint8Array => overlaid(h.data, 0, Number.MAX_SAFE_INTEGER, h.writes)
    return {
      open: (path, mode) => {
        opened.push([path, mode])
        if (mode.create && !store.has(path)) serve('create', path)
        const row = stat(path)
        nextHandle += 1
        held.set(nextHandle, {
          path,
          mode,
          row,
          data: store.get(path) ?? new Uint8Array(),
          writes: [],
        })
        return nextHandle
      },
      pread: (fh, offset, size) => bytes(of(fh)).slice(offset, offset + size),
      pwrite: (fh, offset, data) => {
        const h = of(fh)
        h.writes.push([h.mode.append ? bytes(h).length : offset, data])
      },
      fstat: (fh) => {
        const h = of(fh)
        return { ...h.row, size: bytes(h).length }
      },
      ftruncate: (fh, length) => {
        const h = of(fh)
        const data = new Uint8Array(length)
        data.set(bytes(h).subarray(0, length))
        h.data = data
        h.writes = []
      },
      close: (fh) => {
        const h = of(fh)
        held.delete(fh)
        if (!store.has(h.path)) return
        for (const [offset, data] of h.writes) {
          if (h.mode.append) serve('append', h.path, data)
          else serve('pwrite', h.path, data, undefined, { offset })
        }
      },
    }
  }

  function storeSync(): SyncVFS {
    const stat = (path: string): VFSStat => {
      const found = store.get(path)
      if (found !== undefined) {
        return {
          size: found.length,
          isDir: false,
          mode: 0o100000 | STORE_MODE,
          mtimeMs: STORE_MTIME_S * 1000,
        }
      }
      const target = links.get(path)
      if (target !== undefined) {
        return { size: target.length, isDir: false, isLink: true, mode: 0o120777 }
      }
      const inside = [...store.keys(), ...links.keys()].some((k) => k.startsWith(`${path}/`))
      if (inside) return { size: 0, isDir: true, mode: DIR_MODE }
      throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' })
    }
    return {
      ...handlesOver(stat),
      stat,
      readdir: (dir) => {
        const names = new Set<string>()
        for (const key of [...store.keys(), ...links.keys()]) {
          if (!key.startsWith(dir)) continue
          names.add(key.slice(dir.length).split('/')[0] ?? '')
        }
        return [...names]
          .filter((name) => name !== '')
          .map((name) => {
            const row = stat(dir + name)
            return {
              path: row.isDir ? `${dir}${name}/` : dir + name,
              size: row.size,
              isDir: row.isDir,
              ...(row.isLink === true ? { isLink: true } : {}),
              mode: row.mode,
            }
          })
      },
      readlink: (path) => {
        const target = links.get(path)
        if (target === undefined) throw new Error(`not a link: ${path}`)
        return target
      },
      flush: (mutations) => {
        for (const mutation of mutations) {
          flushed.push(mutation)
          serveMutation(mutation)
        }
        return undefined
      },
      checkPath: () => undefined,
      xattr: () => undefined,
    }
  }

  // The worker shape: nothing is seeded, and every lookup, listing and
  // read goes through a synchronous channel, here a double over the rows
  // and stats a test hands it.
  function mountOver(prefix: string, sync: SyncVFS): PyodideFs {
    mounts.push(prefix)
    const mountpoint = prefix.slice(0, -1)
    const fs = new PyodideFs(
      py.FS,
      py.ERRNO_CODES,
      journal,
      mountpoint,
      (path) => files.mountOf(path),
      sync,
    )
    py.FS.mkdirTree(mountpoint)
    py.FS.mount(fs.type, {}, mountpoint)
    return fs
  }

  function syncOver(
    rows: Record<string, VFSEntry[]>,
    stats: Record<string, VFSStat | Error>,
    statCalls: string[],
  ): SyncVFS {
    const row = (path: string): VFSStat => {
      const found = stats[path]
      if (found === undefined) {
        throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' })
      }
      if (found instanceof Error) throw found
      return found
    }
    return {
      ...handlesOver(row),
      stat: (path) => {
        statCalls.push(path)
        return row(path)
      },
      readdir: (path) => rows[path] ?? [],
      readlink: (path) => {
        throw new Error(`not a link: ${path}`)
      },
      flush: () => undefined,
      checkPath: () => undefined,
      xattr: () => undefined,
    }
  }

  // The runtime's post-run drain, applied host-side where awaiting the
  // bridge needs no JSPI.
  async function drain(): Promise<void> {
    for (const mutation of journal.takeMutations()) await applyMutation(files, mutation)
  }

  beforeAll(async () => {
    py = await loadPyodideRuntime()
    serve = (op, path, bytes, dst, fields) => {
      calls.push(bytes ? { op, path, bytes: new Uint8Array(bytes) } : { op, path })
      if (op === 'read') {
        const found = store.get(path)
        if (found === undefined) throw new Error(`no such file: ${path}`)
        return found
      }
      if (op === 'write' && bytes !== undefined) store.set(path, new Uint8Array(bytes))
      if (op === 'append' && bytes !== undefined) {
        const base = store.get(path) ?? new Uint8Array()
        const next = new Uint8Array(base.length + bytes.length)
        next.set(base)
        next.set(bytes, base.length)
        store.set(path, next)
      }
      if (op === 'truncate') {
        const next = new Uint8Array(fields?.length ?? 0)
        next.set((store.get(path) ?? new Uint8Array()).subarray(0, next.length))
        store.set(path, next)
      }
      if (op === 'pwrite' && bytes !== undefined) {
        const offset = fields?.offset ?? 0
        const base = store.get(path) ?? new Uint8Array()
        const next = new Uint8Array(Math.max(base.length, offset + bytes.length))
        next.set(base)
        next.set(bytes, offset)
        store.set(path, next)
      }
      if (op === 'create') store.set(path, new Uint8Array())
      if (op === 'unlink') store.delete(path)
      if (op === 'rename' && dst !== undefined) {
        const moved = store.get(path)
        if (moved === undefined) throw new Error(`no such file: ${path}`)
        store.delete(path)
        store.set(dst, moved)
      }
      if (op === 'readdir') {
        const listed = [...store.keys(), ...links.keys()].filter((k) => k.startsWith(path))
        return listed
      }
      if (op === 'stat') {
        const found = store.get(path)
        if (found === undefined) {
          // A link, whose mark rides the resolver, or a path that went
          // away between the listing and the stat.
          throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' })
        }
        return new FileStat({
          name: path,
          size: found.length,
          type: FileType.FILE,
          content: ContentType.TEXT,
          // Deliberately not the tree's own defaults, so a test can
          // tell which of the two a guest's stat answered from.
          mode: STORE_MODE,
          modified: STORE_MTIME,
        })
      }
      if (op === 'symlink' && dst !== undefined) links.set(path, dst)
      if (op === 'readlink') {
        const target = links.get(path)
        if (target === undefined) throw new Error(`not a link: ${path}`)
        return target
      }
      if (op === 'setattr' && fields !== undefined) attrs.push([path, fields])
      return undefined
    }
    const dispatch: BridgeDispatchFn = (op, path, bytes, dst, fields) => {
      try {
        return Promise.resolve(serve(op, path, bytes, dst, fields))
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    // The link source is the double's own name plane, which is what a
    // workspace hands its runtimes: link names per directory.
    files = new RuntimeFiles(
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
    links.clear()
    attrs.length = 0
    flushed.length = 0
    held.clear()
    opened.length = 0
    journal.takeMutations()
    counter += 1
  })

  function prefix(): string {
    return `/m${String(counter)}/`
  }

  it('writes an append through an appending handle, and does not clobber the mount', async () => {
    const p = prefix()
    store.set(`${p}log.txt`, enc.encode('BASE'))
    await mountPrefix(p)
    await py.runPythonAsync(`
with open('${p}log.txt', 'a') as f:
    f.write('+more')
`)
    expect(opened.map(([path, mode]) => [path, mode.append, mode.writable])).toEqual([
      [`${p}log.txt`, true, true],
    ])
    expect(calls.map((c) => c.op)).toEqual(['append'])
    expect(dec.decode(store.get(`${p}log.txt`))).toBe('BASE+more')
    expect(recorded()).toEqual([])
  })

  // What a program leaves on the mount once the journal drains: each
  // name's text, or null for a name that must be gone. A low-level
  // os.open write counts (the shim this replaced patched builtins.open
  // only, so such a write was dropped), and so does a bare os.truncate,
  // which opens no handle at all.
  it.each<[string, Record<string, string>, (p: string) => string, Record<string, string | null>]>([
    [
      'a low-level os.open write',
      {},
      (p) =>
        `import os\nfd = os.open('${p}low.txt', os.O_WRONLY | os.O_CREAT)\nos.write(fd, b'LOWLEVEL')\nos.close(fd)`,
      { 'low.txt': 'LOWLEVEL' },
    ],
    [
      'a bare os.truncate',
      { 't.txt': '12345678' },
      (p) => `import os\nos.truncate('${p}t.txt', 3)`,
      { 't.txt': '123' },
    ],
    [
      'a file created and never written',
      {},
      (p) => `from pathlib import Path\nPath('${p}empty.txt').touch()`,
      { 'empty.txt': '' },
    ],
    [
      'the write-temp-then-rename idiom, in order',
      {},
      (p) =>
        `import os\nwith open('${p}tmp.part', 'w') as f:\n    f.write('ATOMIC')\nos.rename('${p}tmp.part', '${p}final.txt')`,
      { 'final.txt': 'ATOMIC', 'tmp.part': null },
    ],
    [
      'a relative path, against the guest cwd',
      {},
      (p) =>
        `import os\nos.chdir('${p}')\nwith open('rel.txt', 'w') as f:\n    f.write('RELATIVE')`,
      { 'rel.txt': 'RELATIVE' },
    ],
  ])('carries %s to the mount', async (_name, seed, program, expected) => {
    const p = prefix()
    for (const [name, text] of Object.entries(seed)) store.set(`${p}${name}`, enc.encode(text))
    await mountPrefix(p)
    await py.runPythonAsync(program(p))
    await drain()
    for (const [name, text] of Object.entries(expected)) {
      const held = store.get(`${p}${name}`)
      expect(held === undefined ? null : dec.decode(held)).toBe(text)
    }
  })

  it('keeps the guest position when the core refuses a read', async () => {
    const p = prefix()
    const path = `${p}retained.txt`
    store.set(path, enc.encode('abcdef'))
    const sync = storeSync()
    let refuse = false
    const seen: [number, number][] = []
    mountOver(p, {
      ...sync,
      pread: (fh, offset, size) => {
        seen.push([offset, size])
        if (refuse) throw Object.assign(new Error('sealed'), { code: 'EACCES' })
        return sync.pread(fh, offset, size)
      },
    })
    await py.runPythonAsync(`_retained = open('${path}', 'rb', buffering=0)`)
    refuse = true
    await py.runPythonAsync(`
try:
    _retained.read(2)
    _retained_refusal = False
except PermissionError:
    _retained_refusal = _retained.tell() == 0
`)
    expect(py.globals.get('_retained_refusal')).toBe(true)
    refuse = false
    await py.runPythonAsync(`_retained_result = _retained.read(2).decode(); _retained.close()`)
    expect(py.globals.get('_retained_result')).toBe('ab')
    expect(seen).toEqual([
      [0, 2],
      [0, 2],
    ])
  })

  describe.each([false, true])('fstat (detached=%s)', (detached) => {
    it.each(['ENOENT', 'EACCES'] as const)(
      'answers the core refusing %s and keeps the same handle',
      async (code) => {
        const p = prefix()
        const path = `${p}metadata.txt`
        store.set(path, enc.encode('abcdef'))
        const sync = storeSync()
        let refuse = false
        let stats = 0
        const seen: VFSStat[] = []
        mountOver(p, {
          ...sync,
          stat: (name) => {
            stats++
            return sync.stat(name)
          },
          fstat: (fh) => {
            const row = sync.fstat(fh)
            seen.push(row)
            if (refuse) throw Object.assign(new Error('sealed'), { code })
            return row
          },
        })
        await py.runPythonAsync(`
import os
_metadata = open('${path}', 'rb', buffering=0)
_metadata_size = os.fstat(_metadata.fileno()).st_size
`)
        expect(py.globals.get('_metadata_size')).toBe(6)
        if (detached) await py.runPythonAsync(`os.unlink('${path}')`)
        await py.runPythonAsync('_metadata_links = os.fstat(_metadata.fileno()).st_nlink')
        expect(py.globals.get('_metadata_links')).toBe(detached ? 0 : 1)
        const fetched = stats
        refuse = true
        await py.runPythonAsync(`
try:
    os.fstat(_metadata.fileno())
    _metadata_refusal = None
except OSError as error:
    import errno
    _metadata_refusal = error.errno == getattr(errno, '${code}')
`)
        expect(py.globals.get('_metadata_refusal')).toBe(true)
        refuse = false
        await py.runPythonAsync(
          `_metadata_restored = os.fstat(_metadata.fileno()).st_size; _metadata.close()`,
        )
        expect(py.globals.get('_metadata_restored')).toBe(6)
        expect(stats).toBe(fetched)
        expect(seen.at(-1)?.size).toBe(6)
      },
    )
  })

  it('raises the refusal a time edit got', async () => {
    const p = prefix()
    const path = `${p}unstamped.txt`
    store.set(path, enc.encode('abc'))
    const sync = storeSync()
    mountOver(p, {
      ...sync,
      flush: (mutations) => {
        if (mutations.some((m) => m.kind === 'setattr')) {
          throw Object.assign(new Error('sealed'), { code: 'EACCES' })
        }
        return sync.flush(mutations)
      },
    })
    await py.runPythonAsync(`
import os
_unstamped = open('${path}', 'rb', buffering=0)
try:
    os.utime('${path}', (1000, 2000))
    _utime_refused = False
except PermissionError:
    _utime_refused = True
os.fstat(_unstamped.fileno())
_unstamped.close()
`)
    expect(py.globals.get('_utime_refused')).toBe(true)
    expect(attrs).toEqual([])
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
    const kinds = recorded().map((m) => `${m.kind} ${m.path.slice(p.length)}`)
    expect(kinds).toEqual([
      'unlink tree/a.txt',
      'unlink tree/b/c.txt',
      'rmdir tree/b',
      'rmdir tree',
    ])
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
    expect(recorded()).toEqual([])
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
    expect(recorded()).toEqual([])
    // The refused source is still readable in place.
    await py.runPythonAsync(`_kept = open('${p}x.txt').read()`)
    expect(py.globals.get('_kept')).toBe('X')
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

  // Over a worker the node is placed from the listing and its stat is the
  // guest's own: it goes to the mount rather than answering size 0 from
  // the placeholder, so the failure the listing swallowed surfaces here.
  it('asks the mount before it stats a node the listing could not classify', async () => {
    const p = prefix()
    const statCalls: string[] = []
    mountOver(
      p,
      syncOver(
        {
          [p]: [
            { path: `${p}good.json`, size: 2, isDir: false, mode: FILE_MODE, mtimeMs: 0 },
            { path: `${p}bad.json`, size: 0, isDir: false },
          ],
        },
        {
          [`${p}good.json`]: { size: 2, isDir: false, mode: FILE_MODE, mtimeMs: 0 },
          [`${p}bad.json`]: new Error('upstream 502 Bad Gateway'),
        },
        statCalls,
      ),
    )
    await py.runPythonAsync(`
import os
_names = ','.join(sorted(os.listdir('${p}')))
_good = os.stat('${p}good.json').st_size
try:
    os.stat('${p}bad.json')
    _errno = 0
except OSError as e:
    _errno = e.errno
`)
    expect(py.globals.get('_names')).toBe('bad.json,good.json')
    expect(py.globals.get('_good')).toBe(2)
    expect(py.globals.get('_errno')).toBe(py.ERRNO_CODES.EIO)
    expect(statCalls).toContain(`${p}bad.json`)
  })

  // The placeholder is a regular file; a mount that answers "directory"
  // once it recovers turns the node into one the guest can list.
  it('turns a placeholder into a directory when the mount says it is one', async () => {
    const p = prefix()
    mountOver(
      p,
      syncOver(
        {
          [p]: [{ path: `${p}sub`, size: 0, isDir: false }],
          [`${p}sub/`]: [
            { path: `${p}sub/x.json`, size: 2, isDir: false, mode: FILE_MODE, mtimeMs: 0 },
          ],
        },
        { [`${p}sub`]: { size: 0, isDir: true, mode: DIR_MODE, mtimeMs: 0 } },
        [],
      ),
    )
    await py.runPythonAsync(`
import os, stat
os.listdir('${p}')
_isdir = stat.S_ISDIR(os.stat('${p}sub').st_mode)
_inner = ','.join(os.listdir('${p}sub'))
`)
    expect(py.globals.get('_isdir')).toBe(true)
    expect(py.globals.get('_inner')).toBe('x.json')
  })

  // A child process may change anything the tree served, so the runtime
  // forgets every node once one returns. A stream the guest still holds
  // reads and writes on through its core handle, as a descriptor keeps
  // its inode.
  it('keeps an open handle whole across an invalidation', async () => {
    const p = prefix()
    const row = { size: 11, isDir: false, mode: FILE_MODE, mtimeMs: 0 }
    store.set(`${p}held.txt`, enc.encode('hello world'))
    const fs = mountOver(
      p,
      syncOver({ [p]: [{ path: `${p}held.txt`, ...row }] }, { [`${p}held.txt`]: row }, []),
    )
    await py.runPythonAsync(`
_held = open('${p}held.txt', 'r+b', buffering=0)
_head = _held.read(5).decode()
`)
    fs.invalidate()
    await py.runPythonAsync(`
_tail = _held.read().decode()
_held.seek(0)
_held.write(b'HELLO')
_held.close()
`)
    await drain()
    expect(py.globals.get('_head')).toBe('hello')
    expect(py.globals.get('_tail')).toBe(' world')
    expect(dec.decode(store.get(`${p}held.txt`))).toBe('HELLO world')
  })

  it('keeps landing writes through a handle whose removal the mount refused', async () => {
    // An open file is marked gone only once the mount took the removal, so
    // a refused unlink leaves the handle writing to the file it still is.
    const p = prefix()
    store.set(`${p}kept.txt`, enc.encode('hello'))
    const sync = storeSync()
    mountOver(p, {
      ...sync,
      flush: (mutations) => {
        const at = mutations.findIndex((m) => m.kind === 'unlink')
        if (at < 0) return sync.flush(mutations)
        sync.flush(mutations.slice(0, at))
        return { message: 'refused', skipped: mutations.length - at - 1, code: 'EACCES' }
      },
    })
    await py.runPythonAsync(`
import os
_kept = open('${p}kept.txt', 'r+b', buffering=0)
try:
    os.unlink('${p}kept.txt')
    _refused = None
except OSError as e:
    _refused = type(e).__name__
_kept.write(b'X')
_kept.close()
`)
    expect(py.globals.get('_refused')).toBe('PermissionError')
    expect(dec.decode(store.get(`${p}kept.txt`))).toBe('Xello')
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

  it('reports the owner and access time the mount gives, in 512-byte blocks', async () => {
    const p = prefix()
    const row = {
      size: 1000,
      isDir: false,
      mode: FILE_MODE,
      mtimeMs: 2_000_000,
      atimeMs: 1_000_000,
      uid: 501,
      gid: 20,
    }
    mountOver(p, syncOver({}, { [`${p}f.bin`]: row }, []))
    await py.runPythonAsync(`
import os
_st = os.stat('${p}f.bin')
_seen = f'{_st.st_uid}:{_st.st_gid} {int(_st.st_atime)} {_st.st_blocks}'
`)
    expect(py.globals.get('_seen')).toBe('501:20 1000 2')
  })

  // The core reads what is stored for a writing handle and the rendering
  // for a reading one, so the stream's access is what it must be told.
  it('opens a reading stream read-only and a writing one writable', async () => {
    const p = prefix()
    const row = { size: 3, isDir: false, mode: FILE_MODE, mtimeMs: 0 }
    store.set(`${p}r.txt`, enc.encode('abc'))
    store.set(`${p}w.txt`, enc.encode('abc'))
    mountOver(p, syncOver({}, { [`${p}r.txt`]: row, [`${p}w.txt`]: row }, []))
    await py.runPythonAsync(`
open('${p}r.txt').read()
f = open('${p}w.txt', 'r+')
f.read()
f.close()
`)
    expect(opened.map(([path, mode]) => [path, mode.readable, mode.writable])).toEqual([
      [`${p}r.txt`, true, false],
      [`${p}w.txt`, true, true],
    ])
  })

  // A file whose name went has only the bytes its handles hold, so a
  // resize goes to a handle that writes it (tempfile.TemporaryFile's).
  it('resizes a file with no name left through its handle', async () => {
    const p = prefix()
    await mountPrefix(p)
    await py.runPythonAsync(`
import os
_tmp = open('${p}scratch', 'w+b', buffering=0)
os.unlink('${p}scratch')
_tmp.write(b'abcdef')
_tmp.truncate(3)
_tmp.seek(0)
_shrunk = _tmp.read().decode()
_tmp.close()
`)
    expect(py.globals.get('_shrunk')).toBe('abc')
    expect(store.has(`${p}scratch`)).toBe(false)
  })

  it('keeps a group the mount reports without an owner', async () => {
    const p = prefix()
    const row = { size: 1, isDir: false, mode: FILE_MODE, mtimeMs: 0, gid: 20 }
    mountOver(p, syncOver({}, { [`${p}g.txt`]: row }, []))
    await py.runPythonAsync(`
import os
_gid = os.stat('${p}g.txt').st_gid
`)
    expect(py.globals.get('_gid')).toBe(20)
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
