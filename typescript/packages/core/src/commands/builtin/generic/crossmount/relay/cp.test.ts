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
import { IOResult } from '../../../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../../../types.ts'
import { mountKey } from '../../../../../utils/key_prefix.ts'
import { rstripSlash } from '../../../../../utils/slash.ts'
import type { DispatchFn } from '../types.ts'
import { runCp } from './cp.ts'

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    resourcePath: mountKey(path, ''),
  })
}

function makeDispatch(files: Map<string, Uint8Array>, dirs: Set<string>): DispatchFn {
  return (op: string, path: PathSpec, args?: readonly unknown[]) => {
    const k = rstripSlash(path.virtual)
    const name = k.split('/').pop() ?? ''
    if (op === 'stat') {
      if (dirs.has(k)) {
        return Promise.resolve([new FileStat({ name, type: FileType.DIRECTORY }), new IOResult()])
      }
      if (files.has(k)) {
        return Promise.resolve([new FileStat({ name, type: FileType.TEXT }), new IOResult()])
      }
      return Promise.reject(new Error(`not found: ${k}`))
    }
    if (op === 'read') return Promise.resolve([files.get(k) ?? null, new IOResult()])
    if (op === 'readdir') {
      const base = k + '/'
      return Promise.resolve([
        [...files.keys()].filter((f) => f.startsWith(base)).sort(),
        new IOResult(),
      ])
    }
    if (op === 'write') {
      files.set(k, args?.[0] as Uint8Array)
      return Promise.resolve([null, new IOResult()])
    }
    if (op === 'mkdir') {
      dirs.add(k)
      return Promise.resolve([null, new IOResult()])
    }
    return Promise.resolve([null, new IOResult()])
  }
}

describe('crossmount cp relay', () => {
  it('records the source as a read so the cache is populated', async () => {
    const files = new Map([['/src/a.txt', new Uint8Array([1, 2, 3])]])
    const dispatch = makeDispatch(files, new Set(['/src']))
    const [, io] = await runCp([spec('/src/a.txt'), spec('/dst/a.txt')], {}, dispatch)
    expect(files.get('/dst/a.txt')).toEqual(new Uint8Array([1, 2, 3]))
    expect(Object.keys(io.reads)).toEqual(['/src/a.txt'])
    expect(io.cache).toEqual(['/src/a.txt'])
  })

  it('records reads for every file of a recursive copy', async () => {
    const files = new Map([
      ['/src/x.txt', new Uint8Array([1])],
      ['/src/sub/y.txt', new Uint8Array([2])],
    ])
    const dispatch = makeDispatch(files, new Set(['/src', '/src/sub']))
    const [, io] = await runCp([spec('/src'), spec('/dst')], { r: true }, dispatch)
    expect(files.has('/dst/x.txt')).toBe(true)
    expect(files.has('/dst/sub/y.txt')).toBe(true)
    expect(new Set(Object.keys(io.reads))).toEqual(new Set(['/src/x.txt', '/src/sub/y.txt']))
  })
})
