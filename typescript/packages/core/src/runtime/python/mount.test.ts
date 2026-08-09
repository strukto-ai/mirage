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
import { PyodideRuntime } from './pyodide.ts'
import type { BridgeDispatchFn } from '../types.ts'

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
    if (op === 'WRITE') {
      files.set(path, normalizedBytes ?? new Uint8Array())
      return Promise.resolve(undefined)
    }
    if (op === 'APPEND') {
      const base = files.get(path) ?? new Uint8Array()
      const tail = normalizedBytes ?? new Uint8Array()
      const next = new Uint8Array(base.length + tail.length)
      next.set(base)
      next.set(tail, base.length)
      files.set(path, next)
      return Promise.resolve(undefined)
    }
    if (op === 'READ') return Promise.resolve(files.get(path) ?? new Uint8Array())
    const prefix = path
    const entries: { path: string; size: number; isDir: boolean }[] = []
    for (const [p, content] of files) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length)
        if (!rest.includes('/')) {
          entries.push({ path: p, size: content.length, isDir: false })
        }
      }
    }
    return Promise.resolve(entries)
  }
  return { dispatch, calls, files }
}

describe('PyodideRuntime mount visibility', () => {
  it('mounted prefixes are preloaded into MEMFS so Python reads see them', async () => {
    const { dispatch, files } = makeBridge()
    files.set('/ram/hello.txt', new TextEncoder().encode('world'))
    const rt = new PyodideRuntime()
    rt.attach(dispatch, () => ['/ram/'])
    const result = await rt.run({
      code: `with open('/ram/hello.txt') as f: print(f.read())`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(new TextDecoder().decode(result.stdout)).toContain('world')
    expect(result.exitCode).toBe(0)
    await rt.close()
  }, 60_000)

  it('writes under a mounted prefix flush via the bridge on close', async () => {
    const { dispatch, calls } = makeBridge()
    const rt = new PyodideRuntime()
    rt.attach(dispatch, () => ['/ram/'])
    await rt.run({
      code: `with open('/ram/out.txt', 'wb') as f: f.write(b'data')`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    const writes = calls.filter((c) => c.op === 'WRITE')
    expect(writes).toHaveLength(1)
    const w0 = writes[0]
    if (w0?.bytes === undefined) throw new Error('unreachable')
    expect(w0.path).toBe('/ram/out.txt')
    expect(new TextDecoder().decode(w0.bytes)).toBe('data')
    await rt.close()
  }, 60_000)

  it('removing a prefix from the live mount view stops flushing', async () => {
    const { dispatch, calls } = makeBridge()
    const mounts: string[] = ['/ram/']
    const rt = new PyodideRuntime()
    rt.attach(dispatch, () => mounts)
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
    expect(calls.filter((c) => c.op === 'WRITE')).toHaveLength(0)
    await rt.close()
  }, 60_000)

  it('a prefix added to the live mount view after boot is backfilled on access', async () => {
    const { dispatch, calls, files } = makeBridge()
    files.set('/ram/lazy.txt', new TextEncoder().encode('lazy'))
    const mounts: string[] = []
    const rt = new PyodideRuntime()
    rt.attach(dispatch, () => mounts)
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
    expect(calls.some((c) => c.op === 'LIST' && c.path === '/ram/')).toBe(true)
    await rt.close()
  }, 60_000)

  it('a root mount is refused rather than mounted at nothing', async () => {
    // `/` is already MEMFS's mount root, so Emscripten answers EBUSY;
    // the empty mountpoint it used to compute mounts a detached
    // filesystem, and the guest then reads and writes MEMFS while a
    // write reports success the resource never sees.
    const { dispatch, calls } = makeBridge()
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (msg: unknown) => warnings.push(String(msg))
    const rt = new PyodideRuntime()
    rt.attach(dispatch, () => ['/'])
    try {
      const result = await rt.run({
        code: `open('/out.txt', 'wb').write(b'data')`,
        args: [],
        env: {},
        stdin: new Uint8Array(),
      })
      expect(result.exitCode).toBe(0)
      expect(calls.filter((c) => c.op === 'WRITE')).toHaveLength(0)
      expect(warnings.some((w) => w.includes("cannot serve a mount at '/'"))).toBe(true)
      // Reported once, not once per run.
      await rt.run({ code: 'pass', args: [], env: {}, stdin: new Uint8Array() })
      expect(warnings.filter((w) => w.includes('cannot serve a mount'))).toHaveLength(1)
    } finally {
      console.warn = warn
      await rt.close()
    }
  }, 60_000)

  it('a nested prefix stays reachable under its parent mount', async () => {
    // prefixes() is longest-first; mounting in that order puts /data
    // over the /data/inner mounted a moment earlier and orphans it.
    const { dispatch, files } = makeBridge()
    files.set('/data/outer.txt', new TextEncoder().encode('OUTER'))
    files.set('/data/inner/deep.txt', new TextEncoder().encode('DEEP'))
    const rt = new PyodideRuntime()
    rt.attach(dispatch, () => ['/data/', '/data/inner/'])
    const result = await rt.run({
      code: "print(open('/data/outer.txt').read(), open('/data/inner/deep.txt').read())",
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toContain('OUTER DEEP')
    await rt.close()
  }, 60_000)

  it('a failed flush surfaces on stderr and flips a clean exit to 1', async () => {
    const dispatch: BridgeDispatchFn = (op) => {
      if (op === 'WRITE') return Promise.reject(new Error('mount is read-only'))
      if (op === 'READ') return Promise.resolve(new Uint8Array())
      return Promise.resolve([])
    }
    const rt = new PyodideRuntime()
    rt.attach(dispatch, () => ['/ram/'])
    const result = await rt.run({
      code: `with open('/ram/out.txt', 'wb') as f: f.write(b'data')`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(result.exitCode).toBe(1)
    const stderr = new TextDecoder().decode(result.stderr ?? new Uint8Array())
    expect(stderr).toContain('failed to write /ram/out.txt')
    expect(stderr).toContain('mount is read-only')
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
      if (op === 'WRITE') return Promise.reject(new Error('backend hiccup'))
      if (op === 'READ') return Promise.resolve(new Uint8Array())
      if (op === 'LIST') return Promise.resolve([])
      return Promise.resolve(undefined)
    }
    const rt = new PyodideRuntime()
    rt.attach(dispatch, () => ['/ram/'])
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
    // The rename must not run: its prerequisite write never landed, so
    // replaying it could move a stale backend copy onto the destination.
    expect(attempted.filter((c) => c.startsWith('RENAME'))).toHaveLength(0)
    const stderr = new TextDecoder().decode(result.stderr ?? new Uint8Array())
    expect(stderr).toContain('failed to write /ram/tmp.txt')
    expect(stderr).toContain('skipped 1 later mutation(s)')
    expect(result.exitCode).toBe(1)
    await rt.close()
  }, 60_000)

  it('an unreadable base refuses the open rather than replacing the file', async () => {
    const writes: Uint8Array[] = []
    // The mount lists the file, so it exists, but will not hand over its
    // content. Leaving it out of the guest's tree would read as absence,
    // and the append would then ship its tail as the whole file.
    const dispatch: BridgeDispatchFn = (op, path, bytes) => {
      if (op === 'READ' && path === '/ram/log.txt') {
        return Promise.reject(new Error('backend unavailable'))
      }
      if (op === 'READ') return Promise.resolve(new Uint8Array())
      if (op === 'LIST') {
        return Promise.resolve([{ path: '/ram/log.txt', size: 4, isDir: false }])
      }
      if (op === 'WRITE' && bytes !== undefined) writes.push(new Uint8Array(bytes))
      return Promise.resolve(undefined)
    }
    const rt = new PyodideRuntime()
    rt.attach(dispatch, () => ['/ram/'])
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
