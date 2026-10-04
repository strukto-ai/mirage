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

import { WorkspaceBinding } from './binding.ts'
import { describe, expect, it } from 'vitest'
import { ContentType, FileStat, FileType } from '../types.ts'
import { MontyRuntime } from './python/monty/index.ts'
import { PyodideRuntime } from './python/pyodide/runtime.ts'
import { QuickJsRuntime } from './js/quickjs/runtime.ts'
import type { BridgeDispatchFn, RunArgs } from './types.ts'
import { PrefixResolver } from './resolver.ts'

interface CountingBridge {
  dispatch: BridgeDispatchFn
  files: Map<string, Uint8Array>
  mutationBytes: () => number
  mutationOps: () => string[]
}

function makeCountingBridge(seed: Record<string, string>): CountingBridge {
  const enc = new TextEncoder()
  const files = new Map<string, Uint8Array>()
  for (const [key, value] of Object.entries(seed)) files.set(key, enc.encode(value))
  const dirs = new Set<string>()
  const ops: [op: string, path: string, bytes: number][] = []
  const dispatch: BridgeDispatchFn = (op, path, bytes, dst) => {
    ops.push([op, path, bytes?.length ?? 0])
    if (op === 'read') {
      const hit = files.get(path)
      if (hit === undefined) return Promise.reject(new Error(`ENOENT ${path}`))
      return Promise.resolve(new Uint8Array(hit))
    }
    if (op === 'write') {
      files.set(path, bytes === undefined ? new Uint8Array() : new Uint8Array(bytes))
      return Promise.resolve(undefined)
    }
    if (op === 'append') {
      const base = files.get(path) ?? new Uint8Array()
      const tail = bytes ?? new Uint8Array()
      const next = new Uint8Array(base.length + tail.length)
      next.set(base)
      next.set(tail, base.length)
      files.set(path, next)
      return Promise.resolve(undefined)
    }
    if (op === 'stat') {
      const hit = files.get(path)
      if (hit !== undefined)
        return Promise.resolve(
          new FileStat({
            name: path,
            size: hit.length,
            type: FileType.FILE,
            content: ContentType.TEXT,
          }),
        )
      const dir = path.replace(/\/$/, '')
      const isDir = dirs.has(dir) || [...files.keys()].some((p) => p.startsWith(dir + '/'))
      if (isDir) return Promise.resolve(new FileStat({ name: path, type: FileType.DIRECTORY }))
      return Promise.reject(new Error(`ENOENT ${path}`))
    }
    if (op === 'readdir') {
      const prefix = path.replace(/\/$/, '') + '/'
      const entries: string[] = []
      for (const p of files.keys()) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) entries.push(p)
      }
      return Promise.resolve(entries)
    }
    if (op === 'unlink') {
      files.delete(path)
      return Promise.resolve(undefined)
    }
    if (op === 'mkdir') {
      dirs.add(path)
      return Promise.resolve(undefined)
    }
    if (op === 'rmdir') {
      dirs.delete(path)
      return Promise.resolve(undefined)
    }
    const moved = files.get(path)
    if (moved !== undefined && dst !== undefined) {
      files.delete(path)
      files.set(dst, moved)
    }
    return Promise.resolve(undefined)
  }
  // Both spellings count: the question is how many bytes crossed the
  // transport, and a runtime that ships tails is exactly the one being
  // measured. Counting WRITE alone would score a working append as 0.
  const isMutation = (op: string): boolean => op === 'write' || op === 'append'
  const mutationBytes = () =>
    ops.filter(([op]) => isMutation(op)).reduce((total, [, , size]) => total + size, 0)
  const mutationOps = () =>
    ops.filter(([op]) => isMutation(op)).map(([op, path]) => `${op} ${path}`)
  return { dispatch, files, mutationBytes, mutationOps }
}

const APPEND_LOOP_PY =
  "for i in range(8):\n    with open('/data/log.txt', 'a') as f:\n        f.write('xyz')"
const APPEND_LOOP_JS =
  "for (let i = 0; i < 8; i++) { const w = std.open('/data/log.txt', 'a'); w.puts('xyz'); w.close() }"

function runArgs(code: string): RunArgs {
  return { code, args: [], env: {}, stdin: null }
}

// Eight appends of three bytes must ship 24 bytes, not O(n^2). The
// dispatch is counted rather than the outcome compared: an amplifying
// runtime still produces the right final content, so the file alone
// cannot tell one append from a full rewrite per close.
describe('append ships only the deltas', () => {
  it.each<[string, () => MontyRuntime | PyodideRuntime | QuickJsRuntime, string]>([
    ['monty', () => new MontyRuntime(), APPEND_LOOP_PY],
    ['pyodide', () => new PyodideRuntime(), APPEND_LOOP_PY],
    ['quickjs', () => new QuickJsRuntime(), APPEND_LOOP_JS],
  ])(
    '%s',
    async (_name, make, program) => {
      const counting = makeCountingBridge({ '/data/log.txt': 'S'.repeat(64) })
      const rt = make()
      rt.bind(new WorkspaceBinding(counting.dispatch, new PrefixResolver(() => ['/data/'])))
      const result = await rt.run(runArgs(program))
      await rt.close()
      expect(result.exitCode).toBe(0)
      const dec = new TextDecoder()
      expect(dec.decode(counting.files.get('/data/log.txt'))).toBe('S'.repeat(64) + 'xyz'.repeat(8))
      expect(counting.mutationBytes(), counting.mutationOps().join(', ')).toBe(24)
    },
    120_000,
  )
})
