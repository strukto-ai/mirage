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

import { beforeAll, describe, expect, it } from 'vitest'
import { PyodideRuntime } from './pyodide.ts'
import type { BridgeDispatchFn } from '../types.ts'
import { ContentType, FileStat, FileType } from '../../types.ts'
import { PrefixResolver } from '../resolver.ts'

// The vitest pool runs every fork with --experimental-wasm-jspi, which no
// production embedder does (V8 flags cannot ride NODE_OPTIONS), so a JSPI
// dependency in the write path only ever fails outside CI. Deleting the
// detection surface before pyodide loads makes this file the production
// environment: run_sync raises here, and file writes must still land.
describe('PyodideRuntime without JSPI', () => {
  beforeAll(() => {
    delete (WebAssembly as { Suspending?: unknown }).Suspending
    delete (WebAssembly as { Suspender?: unknown }).Suspender
    expect('Suspending' in WebAssembly).toBe(false)
  })

  it('a dirty close flushes to the mount and the script exits 0', async () => {
    const calls: { op: string; path: string; bytes?: Uint8Array }[] = []
    const dispatch: BridgeDispatchFn = async (op, path, bytes) => {
      // settle on a macrotask so a run_sync anywhere in the path would
      // have to suspend, not ride an already-resolved promise
      await new Promise((resolve) => setTimeout(resolve, 1))
      calls.push(bytes ? { op, path, bytes: new Uint8Array(bytes) } : { op, path })
      if (op === 'read') return new Uint8Array()
      if (op === 'readdir') return []
      return undefined
    }
    const rt = new PyodideRuntime()
    rt.attach(dispatch, new PrefixResolver(() => ['/ram/']))
    const result = await rt.run({
      code: `with open('/ram/out.txt', 'wb') as f: f.write(b'landed')`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(new TextDecoder().decode(result.stderr ?? new Uint8Array())).toBe('')
    expect(result.exitCode).toBe(0)
    const writes = calls.filter((c) => c.op === 'write')
    expect(writes).toHaveLength(1)
    const w0 = writes[0]
    if (w0?.bytes === undefined) throw new Error('unreachable')
    expect(w0.path).toBe('/ram/out.txt')
    expect(new TextDecoder().decode(w0.bytes)).toBe('landed')
    await rt.close()
  }, 60_000)

  it('a mount added after boot is preloaded host-side, no lazy backfill needed', async () => {
    const files = new Map<string, Uint8Array>([
      ['/late/hello.txt', new TextEncoder().encode('late-mount')],
    ])
    const dispatch: BridgeDispatchFn = async (op, path) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      if (op === 'read') return files.get(path) ?? new Uint8Array()
      if (op === 'readdir') {
        return [...files.keys()].filter(
          (p) => p.startsWith(path) && !p.slice(path.length).includes('/'),
        )
      }
      if (op === 'stat') {
        const found = files.get(path)
        if (found === undefined)
          throw Object.assign(new Error(`no such file: ${path}`), {
            code: 'ENOENT',
          })
        return new FileStat({
          name: path,
          size: found.length,
          type: FileType.FILE,
          content: ContentType.TEXT,
        })
      }
      return undefined
    }
    const mounts: string[] = []
    const rt = new PyodideRuntime()
    rt.attach(dispatch, new PrefixResolver(() => mounts))
    await rt.run({ code: 'pass', args: [], env: {}, stdin: new Uint8Array() })
    mounts.push('/late/')
    const result = await rt.run({
      code: `with open('/late/hello.txt') as f: print(f.read())`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(new TextDecoder().decode(result.stdout)).toContain('late-mount')
    expect(result.exitCode).toBe(0)
    await rt.close()
  }, 60_000)

  it('mutations reach the mount in guest order', async () => {
    const calls: { op: string; path: string; dst?: string }[] = []
    const dispatch: BridgeDispatchFn = async (op, path, _bytes, dst) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      calls.push(dst === undefined ? { op, path } : { op, path, dst })
      if (op === 'read') return new Uint8Array()
      if (op === 'readdir') return []
      return undefined
    }
    const rt = new PyodideRuntime()
    rt.attach(dispatch, new PrefixResolver(() => ['/ram/']))
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
    const mutations = calls.filter((c) => c.op !== 'read' && c.op !== 'readdir')
    expect(mutations).toEqual([
      { op: 'mkdir', path: '/ram/box' },
      { op: 'write', path: '/ram/box/f.txt' },
      { op: 'rename', path: '/ram/box/f.txt', dst: '/ram/box/g.txt' },
      { op: 'unlink', path: '/ram/box/g.txt' },
      { op: 'rmdir', path: '/ram/box' },
    ])
    await rt.close()
  }, 60_000)

  it('appending to a file MEMFS never saw extends it, it does not replace it', async () => {
    // The prefix preloads once per runtime, so a file the mount gained
    // afterwards is legitimately absent from MEMFS. An append-mode open
    // then starts from an empty buffer, and shipping that buffer whole
    // would drop what the mount already held.
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
    rt.attach(dispatch, new PrefixResolver(() => ['/ram/']))
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
