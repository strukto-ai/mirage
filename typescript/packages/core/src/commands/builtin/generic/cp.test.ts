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
import { cpGeneric } from './cp.ts'

const DEC = new TextDecoder()

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
  const copy = (src: PathSpec, dst: PathSpec): Promise<void> => {
    const data = files.get(key(src))
    if (data === undefined) return Promise.reject(new Error(`not found: ${key(src)}`))
    files.set(key(dst), data)
    return Promise.resolve()
  }
  const find = (p: PathSpec): Promise<string[]> => {
    const base = key(p) + '/'
    return Promise.resolve([...files.keys()].filter((k) => k.startsWith(base)).sort())
  }
  return { stat, copy, find }
}

async function run(
  files: Map<string, Uint8Array>,
  dirs: Set<string>,
  paths: string[],
  flags: { recursive?: boolean; n?: boolean; v?: boolean } = {},
): Promise<[ByteSource | null, IOResult]> {
  const { stat, copy, find } = makeBackend(files, dirs)
  const result = await cpGeneric(
    paths.map(spec),
    copy,
    find,
    stat,
    flags.recursive === true,
    flags.n === true,
    flags.v === true,
  )
  if (result === null) throw new Error('unexpected null result')
  return result
}

describe('cpGeneric guards', () => {
  it('copies a single source to a new path', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(), ['/a.txt', '/copy.txt'])
    expect(io.exitCode).toBe(0)
    expect(files.has('/copy.txt')).toBe(true)
  })

  it('reports cannot stat for a missing source and continues', async () => {
    const files = new Map([['/b.txt', new Uint8Array([2])]])
    const [, io] = await run(files, new Set(['/d']), ['/missing.txt', '/b.txt', '/d'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain("cp: cannot stat '/missing.txt'")
    expect(files.has('/d/b.txt')).toBe(true)
  })

  it('refuses to copy a file onto itself', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(), ['/a.txt', '/a.txt'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain("cp: '/a.txt' and '/a.txt' are the same file")
  })

  it('refuses the same file via a directory target', async () => {
    const files = new Map([['/d/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(['/d']), ['/d/a.txt', '/d'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain('are the same file')
  })

  it('refuses recursive copy of a directory into itself', async () => {
    const files = new Map([['/d/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(['/d']), ['/d', '/d'], { recursive: true })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain("cp: cannot copy a directory, '/d', into itself")
    expect([...files.keys()]).toEqual(['/d/a.txt'])
  })

  it('refuses recursive copy into a nested subtree', async () => {
    const files = new Map([['/d/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(['/d', '/d/sub']), ['/d', '/d/sub'], {
      recursive: true,
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain('into itself')
    expect([...files.keys()]).toEqual(['/d/a.txt'])
  })

  it('emits quoted verbose lines', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [out] = await run(files, new Set(), ['/a.txt', '/copy.txt'], { v: true })
    expect(DEC.decode((out as Uint8Array | null) ?? new Uint8Array())).toBe(
      "'/a.txt' -> '/copy.txt'\n",
    )
  })

  it('copies a single source into a directory', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(['/d']), ['/a.txt', '/d'])
    expect(io.exitCode).toBe(0)
    expect(files.has('/d/a.txt')).toBe(true)
  })

  it('copies multiple sources into a directory', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(['/d']), ['/a.txt', '/b.txt', '/d'])
    expect(files.has('/d/a.txt')).toBe(true)
    expect(files.has('/d/b.txt')).toBe(true)
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

  it('no-clobber skips an existing target', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([9])],
      ['/d/a.txt', new Uint8Array([1])],
    ])
    await run(files, new Set(['/d']), ['/a.txt', '/d'], { n: true })
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
  })

  it('no-clobber with duplicate basenames keeps the first', async () => {
    const files = new Map([
      ['/x/a.txt', new Uint8Array([1])],
      ['/y/a.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(['/d']), ['/x/a.txt', '/y/a.txt', '/d'], { n: true })
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
  })

  it('duplicate basenames without -n let the last win', async () => {
    const files = new Map([
      ['/x/a.txt', new Uint8Array([1])],
      ['/y/a.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(['/d']), ['/x/a.txt', '/y/a.txt', '/d'])
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([2]))
  })

  it('recursively copies a directory into a new path', async () => {
    const files = new Map([
      ['/src/x.txt', new Uint8Array([1])],
      ['/src/sub/y.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(['/src', '/src/sub']), ['/src', '/dst'], { recursive: true })
    expect(files.has('/dst/x.txt')).toBe(true)
    expect(files.has('/dst/sub/y.txt')).toBe(true)
  })

  it('records writes keyed by destination path', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(['/d']), ['/a.txt', '/b.txt', '/d'])
    expect(new Set(Object.keys(io.writes))).toEqual(new Set(['/d/a.txt', '/d/b.txt']))
  })

  it('a native copy records no reads', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(), ['/a.txt', '/copy.txt'])
    expect(Object.keys(io.reads)).toEqual([])
  })
})
