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

import { mountKey } from '../../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import type { ByteSource, IOResult } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { mvGeneric } from './mv.ts'

function key(p: PathSpec | string): string {
  return rstripSlash(typeof p === 'string' ? p : p.virtual)
}

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    resourcePath: mountKey(path, ''),
  })
}

function makeBackend(files: Map<string, Uint8Array>, dirs: Set<string>) {
  const stat = (p: PathSpec): Promise<FileStat> => {
    const k = key(p)
    if (dirs.has(k)) {
      return Promise.resolve(
        new FileStat({ name: k.split('/').pop() ?? '', type: FileType.DIRECTORY }),
      )
    }
    const data = files.get(k)
    if (data === undefined) return Promise.reject(new Error(`not found: ${k}`))
    return Promise.resolve(new FileStat({ name: k.split('/').pop() ?? '', type: FileType.TEXT }))
  }
  const rename = (src: PathSpec, dst: PathSpec): Promise<void> => {
    const data = files.get(key(src))
    if (data === undefined) return Promise.reject(new Error(`not found: ${key(src)}`))
    files.delete(key(src))
    files.set(key(dst), data)
    return Promise.resolve()
  }
  return { stat, rename }
}

async function run(
  files: Map<string, Uint8Array>,
  dirs: Set<string>,
  paths: string[],
  flags: { n?: boolean; v?: boolean } = {},
): Promise<[ByteSource | null, IOResult]> {
  const { stat, rename } = makeBackend(files, dirs)
  return mvGeneric(paths.map(spec), rename, stat, flags.n === true, flags.v === true)
}

describe('mvGeneric guards', () => {
  it('moves a single source', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'])
    expect(io.exitCode).toBe(0)
    expect(files.has('/b.txt')).toBe(true)
    expect(files.has('/a.txt')).toBe(false)
  })

  it('reports cannot stat for a missing source and continues', async () => {
    const files = new Map([['/b.txt', new Uint8Array([2])]])
    const [, io] = await run(files, new Set(['/d']), ['/missing.txt', '/b.txt', '/d'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain("mv: cannot stat '/missing.txt'")
    expect(files.has('/d/b.txt')).toBe(true)
  })

  it('refuses to move a file onto itself and preserves it', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(), ['/a.txt', '/a.txt'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain("mv: '/a.txt' and '/a.txt' are the same file")
    expect(files.has('/a.txt')).toBe(true)
  })

  it('refuses the same file via a directory target', async () => {
    const files = new Map([['/d/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(['/d']), ['/d/a.txt', '/d'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain('are the same file')
    expect(files.has('/d/a.txt')).toBe(true)
  })

  it('refuses moving a directory into its own subtree', async () => {
    const files = new Map([['/d/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(['/d', '/d/sub']), ['/d', '/d/sub'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain("mv: cannot move '/d' to a subdirectory of itself")
    expect(files.has('/d/a.txt')).toBe(true)
  })

  it('moves multiple sources into a directory', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(['/d']), ['/a.txt', '/b.txt', '/d'])
    expect(files.has('/d/a.txt')).toBe(true)
    expect(files.has('/d/b.txt')).toBe(true)
    expect(files.has('/a.txt')).toBe(false)
    expect(files.has('/b.txt')).toBe(false)
  })

  it('refuses multiple sources when the target is not a directory', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
      ['/dst.txt', new Uint8Array([3])],
    ])
    await expect(run(files, new Set(), ['/a.txt', '/b.txt', '/dst.txt'])).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    expect(files.get('/dst.txt')).toEqual(new Uint8Array([3]))
  })

  it('no-clobber preserves both source and target', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([9])],
      ['/d/a.txt', new Uint8Array([1])],
    ])
    await run(files, new Set(['/d']), ['/a.txt', '/d'], { n: true })
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.get('/a.txt')).toEqual(new Uint8Array([9]))
  })

  it('no-clobber with duplicate basenames keeps the skipped source', async () => {
    const files = new Map([
      ['/x/a.txt', new Uint8Array([1])],
      ['/y/a.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(['/d']), ['/x/a.txt', '/y/a.txt', '/d'], { n: true })
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.has('/x/a.txt')).toBe(false)
    expect(files.get('/y/a.txt')).toEqual(new Uint8Array([2]))
  })

  it('records writes for both source and target', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(['/d']), ['/a.txt', '/d'])
    expect(new Set(Object.keys(io.writes))).toEqual(new Set(['/a.txt', '/d/a.txt']))
  })
})
