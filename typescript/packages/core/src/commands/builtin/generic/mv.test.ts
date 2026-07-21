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
import { FileStat, FileType, PathSpec, type PrimitiveMove } from '../../../types.ts'
import { eacces, enotsup } from '../../../utils/errors.ts'
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
  return mvGeneric(paths.map(spec), stat, { rename }, flags.n === true, flags.v === true)
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

interface PrimitiveFails {
  readFails?: Map<string, Error>
  writeFails?: Map<string, Error>
  unlinkFails?: Map<string, Error>
  rmdirFails?: Map<string, Error>
}

function makePrimitive(files: Map<string, Uint8Array>, dirs: Set<string>, fails: PrimitiveFails) {
  const { stat } = makeBackend(files, dirs)
  const readErr = fails.readFails ?? new Map<string, Error>()
  const writeErr = fails.writeFails ?? new Map<string, Error>()
  const unlinkErr = fails.unlinkFails ?? new Map<string, Error>()
  const rmdirErr = fails.rmdirFails ?? new Map<string, Error>()
  const readBytes = (p: PathSpec): Promise<Uint8Array> => {
    const err = readErr.get(key(p))
    if (err !== undefined) return Promise.reject(err)
    const data = files.get(key(p))
    if (data === undefined) return Promise.reject(new Error(`not found: ${key(p)}`))
    return Promise.resolve(data)
  }
  const write = (p: PathSpec, data: Uint8Array): Promise<void> => {
    const err = writeErr.get(key(p))
    if (err !== undefined) return Promise.reject(err)
    files.set(key(p), data)
    return Promise.resolve()
  }
  const mkdir = (p: PathSpec): Promise<void> => {
    dirs.add(key(p))
    return Promise.resolve()
  }
  const readdir = (p: PathSpec): Promise<string[]> => {
    const base = key(p) + '/'
    const children = new Set<string>()
    for (const k of [...files.keys(), ...dirs]) {
      if (k.startsWith(base)) children.add(base + (k.slice(base.length).split('/')[0] ?? ''))
    }
    return Promise.resolve([...children].sort())
  }
  const unlink = (p: PathSpec): Promise<void> => {
    const err = unlinkErr.get(key(p))
    if (err !== undefined) return Promise.reject(err)
    files.delete(key(p))
    return Promise.resolve()
  }
  const rmdir = (p: PathSpec): Promise<void> => {
    const err = rmdirErr.get(key(p))
    if (err !== undefined) return Promise.reject(err)
    dirs.delete(key(p))
    return Promise.resolve()
  }
  const strategy: PrimitiveMove = { readBytes, write, mkdir, readdir, unlink, rmdir }
  return { stat, strategy }
}

async function runPrimitive(
  files: Map<string, Uint8Array>,
  dirs: Set<string>,
  paths: string[],
  fails: PrimitiveFails = {},
  flags: { v?: boolean } = {},
): Promise<[ByteSource | null, IOResult]> {
  const { stat, strategy } = makePrimitive(files, dirs, fails)
  return mvGeneric(paths.map(spec), stat, strategy, false, flags.v === true)
}

describe('mvGeneric primitive transfer errors', () => {
  it('moves a file across backends', async () => {
    const files = new Map([
      ['/src/a.txt', new Uint8Array([1])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [, io] = await runPrimitive(files, new Set(['/src', '/d']), ['/src/a.txt', '/d'])
    expect(io.exitCode).toBe(0)
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.has('/src/a.txt')).toBe(false)
    expect(new Set(Object.keys(io.writes))).toEqual(new Set(['/src/a.txt', '/d/a.txt']))
  })

  it('unlink unsupported keeps the destination, GNU cannot remove', async () => {
    // GNU mv on a cross-device move that cannot remove the source: the
    // copy stays in place and the failure is reported per entry.
    const files = new Map([
      ['/src/a.txt', new Uint8Array([1])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [, io] = await runPrimitive(files, new Set(['/src', '/d']), ['/src/a.txt', '/d'], {
      unlinkFails: new Map([['/src/a.txt', enotsup('email', 'unlink', '/src/a.txt')]]),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("mv: cannot remove '/src/a.txt': Operation not supported\n")
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.get('/src/a.txt')).toEqual(new Uint8Array([1]))
    expect(new Set(Object.keys(io.writes))).toEqual(new Set(['/d/a.txt']))
  })

  it('unlink failure continues remaining sources', async () => {
    const files = new Map([
      ['/src/a.txt', new Uint8Array([1])],
      ['/src/b.txt', new Uint8Array([2])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [, io] = await runPrimitive(
      files,
      new Set(['/src', '/d']),
      ['/src/a.txt', '/src/b.txt', '/d'],
      { unlinkFails: new Map([['/src/a.txt', eacces('/src/a.txt')]]) },
    )
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("mv: cannot remove '/src/a.txt': Permission denied\n")
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.get('/d/b.txt')).toEqual(new Uint8Array([2]))
    expect(files.has('/src/b.txt')).toBe(false)
  })

  it('read failure reports cannot open and keeps the source', async () => {
    const files = new Map([
      ['/src/a.txt', new Uint8Array([1])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [, io] = await runPrimitive(files, new Set(['/src', '/d']), ['/src/a.txt', '/d'], {
      readFails: new Map([['/src/a.txt', eacces('/src/a.txt')]]),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "mv: cannot open '/src/a.txt' for reading: Permission denied\n",
    )
    expect(files.has('/d/a.txt')).toBe(false)
    expect(files.get('/src/a.txt')).toEqual(new Uint8Array([1]))
    expect(Object.keys(io.writes)).toEqual([])
  })

  it('write failure reports cannot create regular file', async () => {
    const files = new Map([
      ['/src/a.txt', new Uint8Array([1])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [, io] = await runPrimitive(files, new Set(['/src', '/d']), ['/src/a.txt', '/d'], {
      writeFails: new Map([['/d/a.txt', enotsup('notion', 'write', '/d/a.txt')]]),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "mv: cannot create regular file '/d/a.txt': Operation not supported\n",
    )
    expect(files.get('/src/a.txt')).toEqual(new Uint8Array([1]))
  })

  it('tree unlink failure reports files, never ancestor dirs', async () => {
    // GNU reports each file it cannot remove but never the not-empty
    // ancestor directories; the copied destination tree stays complete.
    const files = new Map([
      ['/src/t/a.txt', new Uint8Array([1])],
      ['/src/t/sub/b.txt', new Uint8Array([2])],
    ])
    const dirs = new Set(['/src', '/src/t', '/src/t/sub', '/d'])
    const [, io] = await runPrimitive(files, dirs, ['/src/t', '/d/t'], {
      unlinkFails: new Map([
        ['/src/t/a.txt', enotsup('email', 'unlink', '/src/t/a.txt')],
        ['/src/t/sub/b.txt', enotsup('email', 'unlink', '/src/t/sub/b.txt')],
      ]),
      rmdirFails: new Map([
        ['/src/t', enotsup('email', 'rmdir', '/src/t')],
        ['/src/t/sub', enotsup('email', 'rmdir', '/src/t/sub')],
      ]),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "mv: cannot remove '/src/t/sub/b.txt': Operation not supported\n" +
        "mv: cannot remove '/src/t/a.txt': Operation not supported\n",
    )
    expect(files.get('/d/t/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.get('/d/t/sub/b.txt')).toEqual(new Uint8Array([2]))
    expect(files.get('/src/t/a.txt')).toEqual(new Uint8Array([1]))
  })

  it('rmdir unsupported on an emptied dir is a completed removal', async () => {
    // A dirless store cannot remove (or even represent) an empty source
    // directory: once the children moved, a failed rmdir of a dir that no
    // longer lists anything is a completed removal, not an error.
    const files = new Map([
      ['/src/t/x.txt', new Uint8Array([1])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const dirs = new Set(['/src', '/src/t', '/d'])
    const [, io] = await runPrimitive(files, dirs, ['/src/t', '/d'], {
      rmdirFails: new Map([['/src/t', enotsup('hf', 'rmdir', '/src/t')]]),
    })
    expect(io.exitCode).toBe(0)
    expect(await io.stderrStr()).toBe('')
    expect(files.get('/d/t/x.txt')).toEqual(new Uint8Array([1]))
    expect(files.has('/src/t/x.txt')).toBe(false)
  })

  it('tree copy failure keeps the whole source and skips removal', async () => {
    // GNU keeps the whole source tree when any copy failed, while the
    // destination keeps the entries that landed.
    const files = new Map([
      ['/src/t/a.txt', new Uint8Array([1])],
      ['/src/t/nr.txt', new Uint8Array([2])],
    ])
    const dirs = new Set(['/src', '/src/t', '/d'])
    const [, io] = await runPrimitive(files, dirs, ['/src/t', '/d/t'], {
      readFails: new Map([['/src/t/nr.txt', eacces('/src/t/nr.txt')]]),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "mv: cannot open '/src/t/nr.txt' for reading: Permission denied\n",
    )
    expect(files.get('/d/t/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.get('/src/t/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.get('/src/t/nr.txt')).toEqual(new Uint8Array([2]))
  })

  it('verbose lists only the moves that fully completed', async () => {
    const files = new Map([
      ['/src/a.txt', new Uint8Array([1])],
      ['/src/b.txt', new Uint8Array([2])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [out] = await runPrimitive(
      files,
      new Set(['/src', '/d']),
      ['/src/a.txt', '/src/b.txt', '/d'],
      { unlinkFails: new Map([['/src/a.txt', eacces('/src/a.txt')]]) },
      { v: true },
    )
    expect(new TextDecoder().decode(out as Uint8Array)).toBe("renamed '/src/b.txt' -> '/d/b.txt'\n")
  })
})
