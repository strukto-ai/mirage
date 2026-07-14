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
import { loadPyodideRuntime, type PyodideInterface } from './loader.ts'
import { createMirageBridge, type BridgeDispatchFn, type MirageEntry } from './mirage_bridge.ts'
import { MIRAGE_FS_SHIM_PY } from './mirage_fs_shim.ts'

interface Call {
  op: string
  path: string
  bytes?: Uint8Array
}

describe('mirage_fs_shim', () => {
  let py: PyodideInterface
  const calls: Call[] = []
  const mounts: string[] = []
  const preloaded = new Map<string, Uint8Array>()
  const lazyFiles = new Map<string, Uint8Array>()
  const lazyListings = new Map<string, MirageEntry[]>()
  const lazyListErrors = new Set<string>()

  function preload(path: string, bytes: Uint8Array): void {
    preloaded.set(path, bytes)
    py.FS.writeFile(path, bytes)
  }

  function seedLazyFile(path: string, bytes: Uint8Array): void {
    lazyFiles.set(path, bytes)
  }

  function seedLazyListing(dir: string, entries: MirageEntry[]): void {
    const norm = dir.endsWith('/') ? dir : dir + '/'
    lazyListings.set(norm, entries)
  }

  beforeAll(async () => {
    py = await loadPyodideRuntime()
    const dispatch: BridgeDispatchFn = (op, path, bytes) => {
      const entry: Call = bytes ? { op, path, bytes: new Uint8Array(bytes) } : { op, path }
      calls.push(entry)
      if (op === 'WRITE') return Promise.resolve(undefined)
      if (op === 'READ') {
        const lazy = lazyFiles.get(path)
        if (lazy !== undefined) return Promise.resolve(lazy)
        return Promise.resolve(preloaded.get(path) ?? new Uint8Array())
      }
      if (lazyListErrors.has(path)) {
        return Promise.reject(new Error(`mock LIST failure: ${path}`))
      }
      return Promise.resolve(lazyListings.get(path) ?? [])
    }
    py.registerJsModule(
      '_mirage_bridge',
      createMirageBridge(dispatch, () => mounts),
    )
    await py.runPythonAsync(MIRAGE_FS_SHIM_PY)
    py.FS.mkdirTree('/ram')
    py.FS.mkdirTree('/tmp')
  }, 60_000)

  beforeEach(() => {
    calls.length = 0
    mounts.length = 0
    preloaded.clear()
    lazyFiles.clear()
    lazyListings.clear()
    lazyListErrors.clear()
  })

  it('flushes a binary write to the bridge on close', async () => {
    mounts.push('/ram/')
    await py.runPythonAsync(`
with open('/ram/hello.txt', 'wb') as f:
    f.write(b'world')
`)
    const writes = calls.filter((c) => c.op === 'WRITE')
    expect(writes).toHaveLength(1)
    const w0 = writes[0]
    if (w0?.bytes === undefined) throw new Error('unreachable')
    expect(w0.path).toBe('/ram/hello.txt')
    expect(new TextDecoder().decode(w0.bytes)).toBe('world')
  })

  it('does not flush writes outside mounted prefixes', async () => {
    mounts.push('/ram/')
    await py.runPythonAsync(`
with open('/tmp/x.txt', 'wb') as f:
    f.write(b'unbridged')
`)
    expect(calls.filter((c) => c.op === 'WRITE')).toHaveLength(0)
  })

  it('text mode write also flushes', async () => {
    mounts.push('/ram/')
    await py.runPythonAsync(`
with open('/ram/x.txt', 'w') as f:
    f.write('hello')
`)
    const writes = calls.filter((c) => c.op === 'WRITE')
    expect(writes).toHaveLength(1)
    const w0 = writes[0]
    if (w0?.bytes === undefined) throw new Error('unreachable')
    expect(w0.path).toBe('/ram/x.txt')
    expect(new TextDecoder().decode(w0.bytes)).toBe('hello')
  })

  it('append mode flushes the full file content on close', async () => {
    preload('/ram/log.txt', new TextEncoder().encode('a'))
    mounts.push('/ram/')
    await py.runPythonAsync(`
with open('/ram/log.txt', 'ab') as f:
    f.write(b'b')
`)
    const writes = calls.filter((c) => c.op === 'WRITE')
    expect(writes).toHaveLength(1)
    const w0 = writes[0]
    if (w0?.bytes === undefined) throw new Error('unreachable')
    expect(w0.path).toBe('/ram/log.txt')
    expect(new TextDecoder().decode(w0.bytes)).toBe('ab')
  })

  it('removing a prefix from the live mount view stops flushing', async () => {
    mounts.push('/ram/')
    mounts.length = 0
    await py.runPythonAsync(`
with open('/ram/x.txt', 'wb') as f:
    f.write(b'nope')
`)
    expect(calls.filter((c) => c.op === 'WRITE')).toHaveLength(0)
  })

  it('reads of preloaded files do not call the bridge', async () => {
    preload('/ram/data.bin', new Uint8Array([1, 2, 3]))
    mounts.push('/ram/')
    await py.runPythonAsync(`
_read_result = open('/ram/data.bin', 'rb').read()
`)
    const bytes = py.globals.get('_read_result') as Uint8Array | { toJs?: () => Uint8Array } | null
    let arr: Uint8Array
    if (bytes instanceof Uint8Array) {
      arr = bytes
    } else if (
      bytes !== null &&
      typeof (bytes as { toJs?: () => Uint8Array }).toJs === 'function'
    ) {
      arr = (bytes as { toJs: () => Uint8Array }).toJs()
    } else {
      throw new Error(`unexpected read_result shape: ${typeof bytes}`)
    }
    expect(Array.from(arr)).toEqual([1, 2, 3])
    expect(calls.filter((c) => c.op === 'READ')).toHaveLength(0)
  })

  it('rejects path traversal — /ram/../etc/x is not in /ram/', async () => {
    mounts.push('/ram/')
    let opened = true
    try {
      await py.runPythonAsync(`
f = open('/ram/../etc/x', 'wb')
f.write(b'x')
f.close()
`)
    } catch {
      opened = false
    }
    void opened
    expect(calls.filter((c) => c.op === 'WRITE' && c.path === '/ram/../etc/x')).toHaveLength(0)
    expect(calls.filter((c) => c.op === 'WRITE' && c.path === '/etc/x')).toHaveLength(0)
  })

  it('r+b mode flushes the modified content on close', async () => {
    preload('/ram/data.bin', new Uint8Array([1, 2, 3, 4]))
    mounts.push('/ram/')
    await py.runPythonAsync(`
with open('/ram/data.bin', 'r+b') as f:
    f.seek(2)
    f.write(b'\\x99\\x99')
`)
    const writes = calls.filter((c) => c.op === 'WRITE')
    expect(writes).toHaveLength(1)
    const w0 = writes[0]
    if (w0?.bytes === undefined) throw new Error('unreachable')
    expect(w0.path).toBe('/ram/data.bin')
    expect(Array.from(w0.bytes)).toEqual([1, 2, 0x99, 0x99])
  })

  it('shim is idempotent — loading twice still works', async () => {
    await py.runPythonAsync(MIRAGE_FS_SHIM_PY)
    mounts.push('/ram/')
    await py.runPythonAsync(`
with open('/ram/x', 'wb') as f:
    f.write(b'y')
`)
    const writes = calls.filter((c) => c.op === 'WRITE')
    expect(writes).toHaveLength(1)
    const w0 = writes[0]
    if (w0?.bytes === undefined) throw new Error('unreachable')
    expect(w0.path).toBe('/ram/x')
    expect(new TextDecoder().decode(w0.bytes)).toBe('y')
  })

  it('os.listdir lazy-fetches paths not in MEMFS but available via the bridge', async () => {
    seedLazyListing('/ram/lazy/', [
      { path: '/ram/lazy/file.txt', size: 10, isDir: false },
      { path: '/ram/lazy/sub', size: 0, isDir: true },
    ])
    seedLazyFile('/ram/lazy/file.txt', new TextEncoder().encode('lazy-bytes'))
    mounts.push('/ram/')
    await py.runPythonAsync(`
import os
_lazy_entries = sorted(os.listdir('/ram/lazy'))
`)
    const entries = py.globals.get('_lazy_entries') as { toJs?: () => string[] } | string[] | null
    let arr: string[]
    if (Array.isArray(entries)) arr = entries
    else if (entries !== null && typeof (entries as { toJs?: () => string[] }).toJs === 'function')
      arr = (entries as { toJs: () => string[] }).toJs()
    else throw new Error('unexpected _lazy_entries shape')
    expect(arr).toEqual(['file.txt', 'sub'])
    expect(calls.filter((c) => c.op === 'LIST' && c.path === '/ram/lazy/')).toHaveLength(1)
  })

  it('open() in read mode lazy-fetches when MEMFS misses', async () => {
    seedLazyListing('/ram/lazyread/', [{ path: '/ram/lazyread/note.txt', size: 5, isDir: false }])
    seedLazyFile('/ram/lazyread/note.txt', new TextEncoder().encode('hello-lazy'))
    mounts.push('/ram/')
    await py.runPythonAsync(`
with open('/ram/lazyread/note.txt', 'rb') as f:
    _lazy_read = f.read()
`)
    const data = py.globals.get('_lazy_read') as Uint8Array | { toJs?: () => Uint8Array } | null
    let bytes: Uint8Array
    if (data instanceof Uint8Array) bytes = data
    else if (data !== null && typeof (data as { toJs?: () => Uint8Array }).toJs === 'function')
      bytes = (data as { toJs: () => Uint8Array }).toJs()
    else throw new Error('unexpected _lazy_read shape')
    expect(new TextDecoder().decode(bytes)).toBe('hello-lazy')
    expect(
      calls.filter((c) => c.op === 'READ' && c.path === '/ram/lazyread/note.txt'),
    ).toHaveLength(1)
  })

  it('os.stat lazy-backfills', async () => {
    seedLazyListing('/ram/lazystat/', [{ path: '/ram/lazystat/data.bin', size: 3, isDir: false }])
    seedLazyFile('/ram/lazystat/data.bin', new Uint8Array([7, 8, 9]))
    mounts.push('/ram/')
    await py.runPythonAsync(`
import os
_lazy_size = os.stat('/ram/lazystat/data.bin').st_size
`)
    const sizeProxy = py.globals.get('_lazy_size') as number | { valueOf?: () => number } | null
    const size = typeof sizeProxy === 'number' ? sizeProxy : Number(sizeProxy)
    expect(size).toBe(3)
  })

  it('lazy backfill is cached — second call does not re-hit the bridge', async () => {
    seedLazyListing('/ram/cached/', [{ path: '/ram/cached/a.txt', size: 1, isDir: false }])
    seedLazyFile('/ram/cached/a.txt', new TextEncoder().encode('A'))
    mounts.push('/ram/')
    await py.runPythonAsync(`
import os
os.listdir('/ram/cached')
os.listdir('/ram/cached')
with open('/ram/cached/a.txt', 'rb') as f:
    _again = f.read()
`)
    expect(calls.filter((c) => c.op === 'LIST' && c.path === '/ram/cached/')).toHaveLength(1)
    expect(calls.filter((c) => c.op === 'READ' && c.path === '/ram/cached/a.txt')).toHaveLength(1)
  })

  it('lazy backfill failure surfaces as FileNotFoundError', async () => {
    lazyListErrors.add('/ram/missing/')
    lazyListErrors.add('/ram/')
    mounts.push('/ram/')
    let raised = false
    try {
      await py.runPythonAsync(`
import os
os.listdir('/ram/missing')
`)
    } catch (err) {
      raised = true
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).toMatch(/FileNotFoundError|No such file/)
    }
    expect(raised).toBe(true)
  })
})
