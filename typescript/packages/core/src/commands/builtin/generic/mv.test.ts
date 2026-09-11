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
import {
  ContentType,
  FileStat,
  FileType,
  PathSpec,
  type PrimitiveMove,
  type ReaddirFn,
} from '../../../types.ts'
import { eacces, enoent, enotdir, enotsup } from '../../../utils/errors.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { mvFlags, mvGeneric, parseFlags, type MvFlags } from './mv.ts'
import { FlagView, type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'

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

function makeBackend(
  files: Map<string, Uint8Array>,
  dirs: Set<string>,
  mtimes?: Map<string, string>,
) {
  const stat = (p: PathSpec): Promise<FileStat> => {
    const k = key(p)
    if (dirs.has(k)) {
      return Promise.resolve(
        new FileStat({ name: k.split('/').pop() ?? '', type: FileType.DIRECTORY }),
      )
    }
    const data = files.get(k)
    if (data === undefined) return Promise.reject(enoent(k))
    return Promise.resolve(
      new FileStat({
        name: k.split('/').pop() ?? '',
        type: FileType.FILE,
        content: ContentType.TEXT,
        modified: mtimes?.get(k) ?? null,
      }),
    )
  }
  const rename = (src: PathSpec, dst: PathSpec): Promise<void> => {
    const data = files.get(key(src))
    if (data === undefined) return Promise.reject(enoent(key(src)))
    files.delete(key(src))
    files.set(key(dst), data)
    return Promise.resolve()
  }
  return { stat, rename }
}

interface RunOpts {
  no_clobber?: boolean
  verbose?: boolean
  flags?: MvFlags
  mtimes?: Map<string, string>
  readdir?: ReaddirFn
}

async function run(
  files: Map<string, Uint8Array>,
  dirs: Set<string>,
  paths: string[],
  opts: RunOpts = {},
): Promise<[ByteSource | null, IOResult]> {
  const { stat, rename } = makeBackend(files, dirs, opts.mtimes)
  const flags =
    opts.flags ?? mvFlags({ noClobber: opts.no_clobber === true, verbose: opts.verbose === true })
  return mvGeneric(paths.map(spec), stat, { rename }, flags, undefined, undefined, opts.readdir)
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

  it('reports a refusing backend rename as cannot move', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const { stat } = makeBackend(files, new Set())
    const rename = (): Promise<void> => Promise.reject(enoent('/missing/a.txt'))
    const [, io] = await mvGeneric(
      ['/a.txt', '/missing/a.txt'].map(spec),
      stat,
      { rename },
      mvFlags({}),
    )
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "mv: cannot move '/a.txt' to '/missing/a.txt': No such file or directory\n",
    )
    expect(files.has('/a.txt')).toBe(true)
  })

  it('reports a rename that hits a non-directory parent as Not a directory', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const { stat } = makeBackend(files, new Set())
    const rename = (): Promise<void> => Promise.reject(enotdir('/plain/c.txt'))
    const [, io] = await mvGeneric(
      ['/a.txt', '/plain/c.txt'].map(spec),
      stat,
      { rename },
      mvFlags({}),
    )
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "mv: cannot move '/a.txt' to '/plain/c.txt': Not a directory\n",
    )
  })

  it('keeps moving the remaining sources after a rename failure', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const dirs = new Set(['/d'])
    const backend = makeBackend(files, dirs)
    const rename = (src: PathSpec, dst: PathSpec): Promise<void> => {
      if (src.virtual === '/a.txt') return Promise.reject(enoent(dst.virtual))
      return backend.rename(src, dst)
    }
    const [, io] = await mvGeneric(
      ['/a.txt', '/b.txt', '/d'].map(spec),
      backend.stat,
      { rename },
      mvFlags({}),
    )
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain("mv: cannot move '/a.txt' to '/d/a.txt'")
    expect(files.has('/d/b.txt')).toBe(true)
    expect(files.has('/a.txt')).toBe(true)
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
    await run(files, new Set(['/d']), ['/a.txt', '/d'], { no_clobber: true })
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.get('/a.txt')).toEqual(new Uint8Array([9]))
  })

  it('no-clobber with duplicate basenames keeps the skipped source', async () => {
    const files = new Map([
      ['/x/a.txt', new Uint8Array([1])],
      ['/y/a.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(['/d']), ['/x/a.txt', '/y/a.txt', '/d'], { no_clobber: true })
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
    if (data === undefined) return Promise.reject(enoent(key(p)))
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
  flags: MvFlags = mvFlags(),
): Promise<[ByteSource | null, IOResult]> {
  const { stat, strategy } = makePrimitive(files, dirs, fails)
  return mvGeneric(paths.map(spec), stat, strategy, flags)
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
      mvFlags({ verbose: true }),
    )
    expect(DEC.decode(out as Uint8Array)).toBe("renamed '/src/b.txt' -> '/d/b.txt'\n")
  })
})

const OLD = '2020-01-01T00:00:00+00:00'
const NEW = '2024-01-01T00:00:00+00:00'

function dirReaddir(files: Map<string, Uint8Array>, dirs: Set<string>): ReaddirFn {
  return (p: PathSpec) => {
    const base = key(p) !== '/' ? key(p) + '/' : '/'
    const children = new Set<string>()
    for (const k of [...files.keys(), ...dirs]) {
      if (k.startsWith(base) && k !== key(p)) {
        children.add(base + (k.slice(base.length).split('/')[0] ?? ''))
      }
    }
    return Promise.resolve([...children].sort())
  }
}

describe('mvGeneric --update and --backup', () => {
  it('older skips a newer destination and keeps the source', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const mtimes = new Map([
      ['/a.txt', OLD],
      ['/b.txt', NEW],
    ])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      mtimes,
      flags: mvFlags({ update: 'older' }),
    })
    expect(io.exitCode).toBe(0)
    expect(files.get('/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.get('/b.txt')).toEqual(new Uint8Array([2]))
  })

  it('older replaces an older destination', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const mtimes = new Map([
      ['/a.txt', NEW],
      ['/b.txt', OLD],
    ])
    await run(files, new Set(), ['/a.txt', '/b.txt'], {
      mtimes,
      flags: mvFlags({ update: 'older' }),
    })
    expect(files.get('/b.txt')).toEqual(new Uint8Array([1]))
    expect(files.has('/a.txt')).toBe(false)
  })

  it('none-fail reports not replacing', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: mvFlags({ update: 'none-fail' }),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("mv: not replacing '/b.txt'\n")
    expect(files.get('/a.txt')).toEqual(new Uint8Array([1]))
  })

  it('backup renames the destination away', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: mvFlags({ backup: 'simple' }),
    })
    expect(files.get('/b.txt')).toEqual(new Uint8Array([1]))
    expect(files.get('/b.txt~')).toEqual(new Uint8Array([2]))
    expect(files.has('/a.txt')).toBe(false)
    expect(Object.keys(io.writes)).toContain('/b.txt~')
  })

  it('annotates the verbose line with the backup', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const [out] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: mvFlags({ verbose: true, backup: 'simple' }),
    })
    expect(DEC.decode(out as Uint8Array)).toBe("renamed '/a.txt' -> '/b.txt' (backup: '/b.txt~')\n")
  })
})

describe('mvGeneric --exchange and --no-copy', () => {
  it('exchange swaps contents', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: mvFlags({ exchange: true }),
    })
    expect(io.exitCode).toBe(0)
    expect(files.get('/a.txt')).toEqual(new Uint8Array([2]))
    expect(files.get('/b.txt')).toEqual(new Uint8Array([1]))
    expect(new Set(Object.keys(io.writes))).toEqual(new Set(['/a.txt', '/b.txt']))
  })

  it('exchange emits its own verbose line', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const [out] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: mvFlags({ exchange: true, verbose: true }),
    })
    expect(DEC.decode(out as Uint8Array)).toBe("exchanged '/a.txt' <-> '/b.txt'\n")
  })

  it('exchange with a missing side errors honestly', async () => {
    // Deliberate divergence: GNU's renameat2 probe reports the unhelpful
    // 'Unknown error -1' here; the honest errno text is used instead.
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: mvFlags({ exchange: true }),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "mv: cannot exchange '/a.txt' and '/b.txt': No such file or directory\n",
    )
    expect(files.get('/a.txt')).toEqual(new Uint8Array([1]))
  })

  it('exchange across mounts is a cross-device refusal', async () => {
    const files = new Map([
      ['/src/a.txt', new Uint8Array([1])],
      ['/d/b.txt', new Uint8Array([2])],
    ])
    const [, io] = await runPrimitive(
      files,
      new Set(['/src', '/d']),
      ['/src/a.txt', '/d/b.txt'],
      {},
      mvFlags({ exchange: true }),
    )
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "mv: cannot exchange '/src/a.txt' and '/d/b.txt': Invalid cross-device link\n",
    )
    expect(files.get('/src/a.txt')).toEqual(new Uint8Array([1]))
  })

  it('no-copy refuses a cross-mount move', async () => {
    const files = new Map([
      ['/src/a.txt', new Uint8Array([1])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [, io] = await runPrimitive(
      files,
      new Set(['/src', '/d']),
      ['/src/a.txt', '/d'],
      {},
      mvFlags({ noCopy: true }),
    )
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "mv: cannot move '/src/a.txt' to '/d/a.txt': Invalid cross-device link\n",
    )
    expect(files.get('/src/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.has('/d/a.txt')).toBe(false)
  })

  it('no-copy leaves a native rename unaffected', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: mvFlags({ noCopy: true }),
    })
    expect(io.exitCode).toBe(0)
    expect(files.get('/b.txt')).toEqual(new Uint8Array([1]))
  })
})

describe('mvGeneric -t/-T', () => {
  it('-T refuses a nonempty directory destination', async () => {
    const files = new Map([
      ['/d1/x.txt', new Uint8Array([1])],
      ['/d2/y.txt', new Uint8Array([2])],
    ])
    const dirs = new Set(['/d1', '/d2'])
    const [, io] = await run(files, dirs, ['/d1', '/d2'], {
      readdir: dirReaddir(files, dirs),
      flags: mvFlags({ noTargetDir: true }),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("mv: cannot overwrite '/d2': Directory not empty\n")
  })

  it('refuses to overwrite a non-directory with a directory', async () => {
    const files = new Map([
      ['/f.txt', new Uint8Array([1])],
      ['/d/x.txt', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(['/d']), ['/d', '/f.txt'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "mv: cannot overwrite non-directory '/f.txt' with directory '/d'\n",
    )
  })

  it('-T refuses a directory destination for a file', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [, io] = await run(files, new Set(['/d']), ['/a.txt', '/d'], {
      flags: mvFlags({ noTargetDir: true }),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "mv: cannot overwrite directory '/d' with non-directory '/a.txt'\n",
    )
  })

  it('-t moves into the target directory', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [, io] = await run(files, new Set(['/d']), ['/a.txt'], {
      flags: mvFlags({ targetDir: '/d' }),
    })
    expect(io.exitCode).toBe(0)
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.has('/a.txt')).toBe(false)
  })

  it('a missing target directory fails the whole command', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(), ['/a.txt'], {
      flags: mvFlags({ targetDir: '/nosuch' }),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("mv: target directory '/nosuch': No such file or directory\n")
    expect(files.get('/a.txt')).toEqual(new Uint8Array([1]))
  })
})

// Flag bags reach parseFlags through a spec-bound view, the way the
// builder and the crossmount relay build it.
function view(bag: Record<string, FlagValue>): FlagView {
  return new FlagView(bag, specOf('mv'))
}

describe('parseFlags', () => {
  it('rejects conflicting combinations', () => {
    expect(() => parseFlags(view({ backup: true, exchange: true }))).toThrow(
      'mv: cannot combine --backup with --exchange, -n, or --update=none-fail',
    )
    expect(() => parseFlags(view({ backup: true, no_clobber: true }))).toThrow(
      'cannot combine --backup',
    )
    expect(() => parseFlags(view({ target_directory: '/d', no_target_directory: true }))).toThrow(
      'cannot combine --target-directory',
    )
  })

  it('resolves the update and exchange grammars', () => {
    const parsed = parseFlags(view({ update: true, exchange: true }))
    expect(parsed.update).toBe('older')
    expect(parsed.exchange).toBe(true)
    expect(parseFlags(view({ no_copy: true })).noCopy).toBe(true)
    // GNU 9.7: `mv --backup --suffix= f g` writes g~, so an empty suffix
    // reads as absent rather than naming the original as its own backup.
    expect(parseFlags(view({ backup: true, suffix: '' })).suffix).toBe('~')
  })
})

// A rename that carries a whole subtree, like a real backend rename.
function treeRename(files: Map<string, Uint8Array>, dirs: Set<string>) {
  return (src: PathSpec, dst: PathSpec): Promise<void> => {
    const s = key(src)
    const d = key(dst)
    if (dirs.has(s)) {
      dirs.delete(s)
      dirs.add(d)
      for (const k of [...files.keys()].filter((k) => k.startsWith(s + '/'))) {
        const data = files.get(k)
        if (data !== undefined) files.set(d + k.slice(s.length), data)
        files.delete(k)
      }
      for (const k of [...dirs].filter((k) => k.startsWith(s + '/'))) {
        dirs.delete(k)
        dirs.add(d + k.slice(s.length))
      }
      return Promise.resolve()
    }
    const data = files.get(s)
    if (data === undefined) return Promise.reject(enoent(s))
    files.delete(s)
    files.set(d, data)
    return Promise.resolve()
  }
}

describe('mv --exchange staging safety', () => {
  it('never clobbers a real file sitting at the staging name', async () => {
    // GNU's renameat2(RENAME_EXCHANGE) is atomic and touches nothing else.
    const files = new Map([
      ['/a.txt', new Uint8Array([65])],
      ['/b.txt', new Uint8Array([66])],
      ['/b.txt.~xchg~', new Uint8Array([80])],
    ])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: mvFlags({ exchange: true }),
    })
    expect(io.exitCode).toBe(0)
    expect(files.get('/a.txt')).toEqual(new Uint8Array([66]))
    expect(files.get('/b.txt')).toEqual(new Uint8Array([65]))
    expect(files.get('/b.txt.~xchg~')).toEqual(new Uint8Array([80]))
  })

  it('rolls the operands back when a later rename fails', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([65])],
      ['/b.txt', new Uint8Array([66])],
    ])
    const { stat, rename } = makeBackend(files, new Set())
    let calls = 0
    const flaky = (src: PathSpec, dst: PathSpec): Promise<void> => {
      calls += 1
      if (calls === 2) return Promise.reject(eacces(dst.virtual))
      return rename(src, dst)
    }
    const [, io] = await mvGeneric(
      ['/a.txt', '/b.txt'].map(spec),
      stat,
      { rename: flaky },
      mvFlags({ exchange: true }),
    )
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain('cannot exchange')
    expect(files.get('/a.txt')).toEqual(new Uint8Array([65]))
    expect(files.get('/b.txt')).toEqual(new Uint8Array([66]))
    expect(files.has('/b.txt.~xchg~')).toBe(false)
  })

  it('reports the leftover staging path when the rollback also fails', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([65])],
      ['/b.txt', new Uint8Array([66])],
    ])
    const { stat, rename } = makeBackend(files, new Set())
    let calls = 0
    const flaky = (src: PathSpec, dst: PathSpec): Promise<void> => {
      calls += 1
      if (calls >= 2) return Promise.reject(eacces(dst.virtual))
      return rename(src, dst)
    }
    const [, io] = await mvGeneric(
      ['/a.txt', '/b.txt'].map(spec),
      stat,
      { rename: flaky },
      mvFlags({ exchange: true }),
    )
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain("'/a.txt' left at '/b.txt.~xchg~'")
  })
})

describe('mv -b -T over a nonempty directory', () => {
  it('lets the backup displace the target instead of refusing', async () => {
    // GNU 9.7 renames the nonempty target aside, then installs the source.
    const files = new Map([
      ['/d1/x.txt', new Uint8Array([88])],
      ['/d2/y.txt', new Uint8Array([89])],
    ])
    const dirs = new Set(['/d1', '/d2'])
    const { stat } = makeBackend(files, dirs)
    const [, io] = await mvGeneric(
      ['/d1', '/d2'].map(spec),
      stat,
      { rename: treeRename(files, dirs) },
      mvFlags({ noTargetDir: true, backup: 'simple' }),
      undefined,
      undefined,
      dirReaddir(files, dirs),
    )
    expect(io.exitCode).toBe(0)
    expect(files.get('/d2/x.txt')).toEqual(new Uint8Array([88]))
    expect(files.get('/d2~/y.txt')).toEqual(new Uint8Array([89]))
  })

  it('still refuses when --backup=none displaces nothing', async () => {
    const files = new Map([
      ['/d1/x.txt', new Uint8Array([88])],
      ['/d2/y.txt', new Uint8Array([89])],
    ])
    const dirs = new Set(['/d1', '/d2'])
    const [, io] = await run(files, dirs, ['/d1', '/d2'], {
      flags: mvFlags({ noTargetDir: true, backup: 'none' }),
      readdir: dirReaddir(files, dirs),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain("mv: cannot overwrite '/d2': Directory not empty")
  })

  it('reports a failed emptiness probe instead of assuming empty', async () => {
    const files = new Map([
      ['/d1/x.txt', new Uint8Array([88])],
      ['/d2/y.txt', new Uint8Array([89])],
    ])
    const dirs = new Set(['/d1', '/d2'])
    const [, io] = await run(files, dirs, ['/d1', '/d2'], {
      flags: mvFlags({ noTargetDir: true }),
      readdir: () => Promise.reject(enotsup('ram', 'readdir', '/d2')),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain("mv: cannot overwrite '/d2': Operation not supported")
    expect(files.get('/d2/y.txt')).toEqual(new Uint8Array([89]))
  })
})
