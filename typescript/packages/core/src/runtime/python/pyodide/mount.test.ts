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

import { WorkspaceBinding } from '../../binding.ts'
import { describe, expect, it } from 'vitest'
import { PyodideRuntime } from './runtime.ts'
import type { BridgeDispatchFn } from '../../types.ts'
import { ContentType, FileStat, FileType } from '../../../types.ts'
import { PrefixResolver } from '../../resolver.ts'

function makeBridge(): {
  dispatch: BridgeDispatchFn
  calls: { op: string; path: string; bytes?: Uint8Array }[]
  files: Map<string, Uint8Array>
} {
  const calls: { op: string; path: string; bytes?: Uint8Array }[] = []
  const files = new Map<string, Uint8Array>()
  const dispatch: BridgeDispatchFn = (op, path, bytes) => {
    const normalizedBytes = bytes ? new Uint8Array(bytes) : undefined
    const entry: { op: string; path: string; bytes?: Uint8Array } =
      normalizedBytes !== undefined ? { op, path, bytes: normalizedBytes } : { op, path }
    calls.push(entry)
    if (op === 'write') {
      files.set(path, normalizedBytes ?? new Uint8Array())
      return Promise.resolve(undefined)
    }
    if (op === 'append') {
      const base = files.get(path) ?? new Uint8Array()
      const tail = normalizedBytes ?? new Uint8Array()
      const next = new Uint8Array(base.length + tail.length)
      next.set(base)
      next.set(tail, base.length)
      files.set(path, next)
      return Promise.resolve(undefined)
    }
    if (op === 'read') return Promise.resolve(files.get(path) ?? new Uint8Array())
    const prefix = path
    const entries: string[] = []
    const dirs = new Set<string>()
    for (const p of files.keys()) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length)
        if (!rest.includes('/')) {
          entries.push(p)
        } else {
          const seg = rest.split('/', 1)[0] ?? ''
          if (seg !== '') dirs.add(prefix + seg)
        }
      }
    }
    // The file adapter builds each row from a name plus one stat, so the double
    // answers both, and a directory is whatever a deeper key implies.
    if (op === 'stat') {
      const found = files.get(path)
      if (found !== undefined) {
        return Promise.resolve(
          new FileStat({
            name: path,
            size: found.length,
            type: FileType.FILE,
            content: ContentType.TEXT,
          }),
        )
      }
      const deeper = [...files.keys()].some((p) => p.startsWith(path + '/'))
      if (deeper) return Promise.resolve(new FileStat({ name: path, type: FileType.DIRECTORY }))
      return Promise.reject(Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' }))
    }
    // The real dispatcher merges child mounts and directories into readdir
    // (R1), so the double reports them too: preload descends through
    // them exactly as it does against a live workspace.
    for (const d of dirs) entries.push(d)
    return Promise.resolve(entries)
  }
  return { dispatch, calls, files }
}

describe('PyodideRuntime mount visibility', () => {
  it('removing a prefix from the live mount view stops flushing', async () => {
    const { dispatch, calls } = makeBridge()
    const mounts: string[] = ['/ram/']
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => mounts)))
    await rt.run({
      code: 'pass',
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    mounts.length = 0
    await rt.run({
      code: `with open('/ram/x.txt', 'wb') as f: f.write(b'nope')`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(calls.filter((c) => c.op === 'write')).toHaveLength(0)
    await rt.close()
  }, 60_000)

  it('a prefix added to the live mount view after boot is backfilled on access', async () => {
    const { dispatch, calls, files } = makeBridge()
    files.set('/ram/lazy.txt', new TextEncoder().encode('lazy'))
    const mounts: string[] = []
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => mounts)))
    await rt.run({
      code: 'pass',
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    mounts.push('/ram/')
    const result = await rt.run({
      code: `with open('/ram/lazy.txt') as f: print(f.read())`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(new TextDecoder().decode(result.stdout)).toContain('lazy')
    expect(calls.filter((c) => c.op === 'readdir')).toEqual([])
    await rt.close()
  }, 60_000)

  it('a root mount is refused rather than mounted at nothing', async () => {
    // `/` is already MEMFS's mount root, so Emscripten answers EBUSY;
    // the empty mountpoint it used to compute mounts a detached
    // filesystem, and the guest then reads and writes MEMFS while a
    // write reports success the VFS never sees.
    const { dispatch, calls } = makeBridge()
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (msg: unknown) => warnings.push(String(msg))
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/'])))
    try {
      const result = await rt.run({
        code: `open('/out.txt', 'wb').write(b'data')`,
        args: [],
        env: {},
        stdin: new Uint8Array(),
      })
      expect(result.exitCode).toBe(0)
      expect(calls.filter((c) => c.op === 'write')).toHaveLength(0)
      expect(warnings.some((w) => w.includes("cannot serve a mount at '/'"))).toBe(true)
      await rt.run({ code: 'pass', args: [], env: {}, stdin: new Uint8Array() })
      expect(warnings.filter((w) => w.includes('cannot serve a mount'))).toHaveLength(2)
    } finally {
      console.warn = warn
      await rt.close()
    }
  }, 60_000)

  it('a refused create fails the open with the mount errno', async () => {
    const dispatch: BridgeDispatchFn = (op) => {
      if (op === 'stat')
        return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      if (op === 'create')
        return Promise.reject(Object.assign(new Error('mount is read-only'), { code: 'EROFS' }))
      if (op === 'read') return Promise.resolve(new Uint8Array())
      return Promise.resolve([])
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/ram/'])))
    const result = await rt.run({
      code: `with open('/ram/out.txt', 'wb') as f: f.write(b'data')`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(result.exitCode).toBe(1)
    const stderr = new TextDecoder().decode(result.stderr ?? new Uint8Array())
    expect(stderr).toContain("OSError: [Errno 69] Read-only file system: '/ram/out.txt'")
    expect(stderr).not.toContain('failed to create')
    await rt.close()
  }, 60_000)

  it('runtime without bridge still runs Python without the shim', async () => {
    const rt = new PyodideRuntime({})
    const result = await rt.run({
      code: 'print("hello")',
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(new TextDecoder().decode(result.stdout)).toContain('hello')
    expect(result.exitCode).toBe(0)
    await rt.close()
  }, 60_000)

  it('a failed mutation stops the replay instead of applying later entries', async () => {
    const attempted: string[] = []
    const dispatch: BridgeDispatchFn = (op, path) => {
      attempted.push(`${op} ${path}`)
      if (op === 'stat')
        return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      if (op === 'create') return Promise.reject(new Error('backend hiccup'))
      if (op === 'read') return Promise.resolve(new Uint8Array())
      if (op === 'readdir') return Promise.resolve([])
      return Promise.resolve(undefined)
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/ram/'])))
    const result = await rt.run({
      code: [
        'import os',
        "open('/ram/tmp.txt', 'wb').write(b'new')",
        "os.rename('/ram/tmp.txt', '/ram/final.txt')",
      ].join('\n'),
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    // The rename must not run: its prerequisite create never landed, and
    // the open that asked for it failed, so the program stopped there.
    expect(attempted.filter((c) => c.startsWith('rename'))).toHaveLength(0)
    const stderr = new TextDecoder().decode(result.stderr ?? new Uint8Array())
    expect(stderr).toContain("OSError: [Errno 29] I/O error: '/ram/tmp.txt'")
    expect(result.exitCode).toBe(1)
    await rt.close()
  }, 60_000)

  it('an unreadable base refuses the open rather than replacing the file', async () => {
    const writes: Uint8Array[] = []
    // The mount lists the file, so it exists, but will not hand over its
    // content. Leaving it out of the guest's tree would read as absence,
    // and the append would then ship its tail as the whole file.
    const dispatch: BridgeDispatchFn = (op, path, bytes) => {
      if (op === 'read' && path === '/ram/log.txt') {
        return Promise.reject(new Error('backend unavailable'))
      }
      if (op === 'read') return Promise.resolve(new Uint8Array())
      if (op === 'readdir') return Promise.resolve(['/ram/log.txt'])
      if (op === 'stat') {
        return Promise.resolve(
          new FileStat({ name: path, size: 4, type: FileType.FILE, content: ContentType.TEXT }),
        )
      }
      if (op === 'write' && bytes !== undefined) writes.push(new Uint8Array(bytes))
      return Promise.resolve(undefined)
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/ram/'])))
    const result = await rt.run({
      code: `open('/ram/log.txt', 'a').write('tail')`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(writes).toHaveLength(0)
    // The refusal reaches the guest at the call site now, rather than
    // surfacing after the run as a failed replay.
    const stderr = new TextDecoder().decode(result.stderr ?? new Uint8Array())
    expect(stderr).toContain('OSError')
    expect(result.exitCode).toBe(1)
    await rt.close()
  }, 60_000)
})

// Every op a bound run makes reaches the mount through the worker, which
// is where the guest's filesystem lives.
describe('PyodideRuntime writes', () => {
  it('a dirty close flushes to the mount and the script exits 0', async () => {
    const calls: { op: string; path: string; bytes?: Uint8Array }[] = []
    const dispatch: BridgeDispatchFn = async (op, path, bytes) => {
      // settle on a macrotask so a run_sync anywhere in the path would
      // have to suspend, not ride an already-resolved promise
      await new Promise((resolve) => setTimeout(resolve, 1))
      calls.push(bytes ? { op, path, bytes: new Uint8Array(bytes) } : { op, path })
      if (op === 'stat') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      if (op === 'read') return new Uint8Array()
      if (op === 'readdir') return []
      return undefined
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/ram/'])))
    const result = await rt.run({
      code: `with open('/ram/out.txt', 'wb') as f: f.write(b'landed')`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(new TextDecoder().decode(result.stderr ?? new Uint8Array())).toBe('')
    expect(result.exitCode).toBe(0)
    const mutations = calls.filter((c) => c.op === 'create' || c.op === 'pwrite')
    expect(mutations.map((c) => `${c.op} ${c.path}`)).toEqual([
      'create /ram/out.txt',
      'pwrite /ram/out.txt',
    ])
    const written = mutations[1]?.bytes
    if (written === undefined) throw new Error('unreachable')
    expect(new TextDecoder().decode(written)).toBe('landed')
    await rt.close()
  }, 60_000)

  it('mutations reach the mount in guest order', async () => {
    const calls: { op: string; path: string; dst?: string }[] = []
    const dispatch: BridgeDispatchFn = async (op, path, _bytes, dst) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      calls.push(dst === undefined ? { op, path } : { op, path, dst })
      if (op === 'stat') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      if (op === 'read') return new Uint8Array()
      if (op === 'readdir') return []
      return undefined
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/ram/'])))
    const result = await rt.run({
      code: [
        'import os',
        "os.mkdir('/ram/box')",
        "open('/ram/box/f.txt', 'wb').write(b'hi')",
        "os.rename('/ram/box/f.txt', '/ram/box/g.txt')",
        "os.remove('/ram/box/g.txt')",
        "os.rmdir('/ram/box')",
      ].join('\n'),
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(new TextDecoder().decode(result.stderr ?? new Uint8Array())).toBe('')
    expect(result.exitCode).toBe(0)
    const mutations = calls.filter((c) => c.op !== 'read' && c.op !== 'readdir' && c.op !== 'stat')
    expect(mutations).toEqual([
      { op: 'mkdir', path: '/ram/box' },
      { op: 'create', path: '/ram/box/f.txt' },
      { op: 'pwrite', path: '/ram/box/f.txt' },
      { op: 'rename', path: '/ram/box/f.txt', dst: '/ram/box/g.txt' },
      { op: 'unlink', path: '/ram/box/g.txt' },
      { op: 'rmdir', path: '/ram/box' },
    ])
    await rt.close()
  }, 60_000)

  it('appending to a file MEMFS never saw extends it, it does not replace it', async () => {
    // A file the mount gained after the runtime's first run has no node
    // yet. An append-mode open of it must start from what the mount
    // holds: shipping an empty buffer whole would drop that.
    const files = new Map<string, Uint8Array>()
    const writes: { path: string; text: string }[] = []
    const dispatch: BridgeDispatchFn = async (op, path, bytes) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      if (op === 'read') {
        const found = files.get(path)
        if (found === undefined) throw new Error(`no such file: ${path}`)
        return found
      }
      if (op === 'readdir') return [...files.keys()]
      if (op === 'stat') {
        const listed = files.get(path)
        if (listed === undefined)
          throw Object.assign(new Error(`no such file: ${path}`), {
            code: 'ENOENT',
          })
        return new FileStat({
          name: path,
          size: listed.length,
          type: FileType.FILE,
          content: ContentType.TEXT,
        })
      }
      if (op === 'write' && bytes !== undefined) {
        files.set(path, new Uint8Array(bytes))
        writes.push({ path, text: new TextDecoder().decode(bytes) })
      }
      if (op === 'append' && bytes !== undefined) {
        const base = files.get(path) ?? new Uint8Array()
        const next = new Uint8Array(base.length + bytes.length)
        next.set(base)
        next.set(bytes, base.length)
        files.set(path, next)
      }
      return undefined
    }
    const rt = new PyodideRuntime()
    rt.bind(new WorkspaceBinding(dispatch, new PrefixResolver(() => ['/ram/'])))
    await rt.run({ code: 'pass', args: [], env: {}, stdin: new Uint8Array() })
    files.set('/ram/log.txt', new TextEncoder().encode('a'))
    const result = await rt.run({
      code: `\nfor part in ['b', 'c']:\n    with open('/ram/log.txt', 'a') as f:\n        f.write(part)\n`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(new TextDecoder().decode(result.stderr ?? new Uint8Array())).toBe('')
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(files.get('/ram/log.txt') ?? new Uint8Array())).toBe('abc')
    await rt.close()
  }, 60_000)
})
