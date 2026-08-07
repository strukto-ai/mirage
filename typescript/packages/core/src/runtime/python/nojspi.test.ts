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
      if (op === 'READ') return new Uint8Array()
      if (op === 'LIST') return []
      return undefined
    }
    const rt = new PyodideRuntime()
    rt.attach(dispatch, () => ['/ram/'])
    const result = await rt.run({
      code: `with open('/ram/out.txt', 'wb') as f: f.write(b'landed')`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(new TextDecoder().decode(result.stderr ?? new Uint8Array())).toBe('')
    expect(result.exitCode).toBe(0)
    const writes = calls.filter((c) => c.op === 'WRITE')
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
      if (op === 'READ') return files.get(path) ?? new Uint8Array()
      if (op === 'LIST') {
        const entries = []
        for (const [p, content] of files) {
          if (p.startsWith(path) && !p.slice(path.length).includes('/')) {
            entries.push({ path: p, size: content.length, isDir: false })
          }
        }
        return entries
      }
      return undefined
    }
    const mounts: string[] = []
    const rt = new PyodideRuntime()
    rt.attach(dispatch, () => mounts)
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
})
