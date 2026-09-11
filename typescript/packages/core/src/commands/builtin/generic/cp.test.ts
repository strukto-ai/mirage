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
  type PrimitiveCopy,
  type ReaddirFn,
  type StatFn,
} from '../../../types.ts'
import type { FindOptions } from '../../../resource/base.ts'
import { eacces, enoent, enotsup } from '../../../utils/errors.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import {
  cpFlags,
  cpGeneric,
  entryKind,
  overwriteGate,
  parseFlags,
  targetDirError,
  type CpFlags,
} from './cp.ts'
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
  const copy = (src: PathSpec, dst: PathSpec): Promise<void> => {
    const data = files.get(key(src))
    if (data === undefined) return Promise.reject(enoent(key(src)))
    files.set(key(dst), data)
    return Promise.resolve()
  }
  const find = (p: PathSpec): Promise<string[]> => {
    const base = key(p) + '/'
    return Promise.resolve([...files.keys()].filter((k) => k.startsWith(base)).sort())
  }
  return { stat, copy, find }
}

interface RunOpts {
  recursive?: boolean
  no_clobber?: boolean
  verbose?: boolean
  flags?: CpFlags
  mtimes?: Map<string, string>
  readdir?: ReaddirFn
}

async function run(
  files: Map<string, Uint8Array>,
  dirs: Set<string>,
  paths: string[],
  opts: RunOpts = {},
): Promise<[ByteSource | null, IOResult]> {
  const { stat, copy, find } = makeBackend(files, dirs, opts.mtimes)
  const flags =
    opts.flags ??
    cpFlags({
      recursive: opts.recursive === true,
      noClobber: opts.no_clobber === true,
      verbose: opts.verbose === true,
    })
  return cpGeneric(paths.map(spec), stat, { copy, find }, flags, undefined, undefined, opts.readdir)
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

  it('into a missing parent reports cannot create regular file', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(['/']), ['/a.txt', '/nodir/x.txt'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "cp: cannot create regular file '/nodir/x.txt': No such file or directory\n",
    )
    expect(files.has('/nodir/x.txt')).toBe(false)
  })

  it('under a plain file reports cannot stat Not a directory', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/plain', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(['/']), ['/a.txt', '/plain/x.txt'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("cp: cannot stat '/plain/x.txt': Not a directory\n")
    expect(files.has('/plain/x.txt')).toBe(false)
  })

  it('deep under a plain file still reports Not a directory', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/plain', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(['/']), ['/a.txt', '/plain/s/x.txt'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("cp: cannot stat '/plain/s/x.txt': Not a directory\n")
  })

  it('a SOURCE under a plain file reports Not a directory, not ENOENT', async () => {
    // Backends answer stat with ENOENT for a path under a plain file, so the
    // source probe has to walk the chain to recover GNU's errno.
    const files = new Map([['/plain', new Uint8Array([2])]])
    const [, io] = await run(files, new Set(['/', '/d']), ['/plain/child', '/d'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("cp: cannot stat '/plain/child': Not a directory\n")
  })

  it('a SOURCE deep under a plain file reports Not a directory', async () => {
    const files = new Map([['/plain', new Uint8Array([2])]])
    const [, io] = await run(files, new Set(['/', '/d']), ['/plain/a/b', '/d'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("cp: cannot stat '/plain/a/b': Not a directory\n")
  })

  it('a genuinely absent source still reports No such file or directory', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(['/', '/d']), ['/nope', '/d'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("cp: cannot stat '/nope': No such file or directory\n")
  })

  it('multiple sources with a missing target report No such file or directory', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    await expect(run(files, new Set(['/']), ['/a.txt', '/b.txt', '/nodir'])).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('multiple sources with a plain-file target report Not a directory', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
      ['/plain', new Uint8Array([3])],
    ])
    await expect(run(files, new Set(['/']), ['/a.txt', '/b.txt', '/plain'])).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
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
    const [out] = await run(files, new Set(), ['/a.txt', '/copy.txt'], { verbose: true })
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
    await run(files, new Set(['/d']), ['/a.txt', '/d'], { no_clobber: true })
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
  })

  it('no-clobber with duplicate basenames keeps the first', async () => {
    const files = new Map([
      ['/x/a.txt', new Uint8Array([1])],
      ['/y/a.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(['/d']), ['/x/a.txt', '/y/a.txt', '/d'], { no_clobber: true })
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
    expect(io.cache).toEqual([])
  })

  it('a primitive copy records source reads', async () => {
    const files = new Map<string, Uint8Array>([['/a.txt', new Uint8Array([1])]])
    const { stat } = makeBackend(files, new Set())
    const readBytes = (p: PathSpec): Promise<Uint8Array> => {
      const data = files.get(key(p))
      if (data === undefined) return Promise.reject(enoent(key(p)))
      return Promise.resolve(data)
    }
    const write = (p: PathSpec, data: Uint8Array): Promise<void> => {
      files.set(key(p), data)
      return Promise.resolve()
    }
    const mkdir = (): Promise<void> => Promise.resolve()
    const readdir = (): Promise<string[]> => Promise.resolve([])
    const [, io] = await cpGeneric(
      [spec('/a.txt'), spec('/copy.txt')],
      stat,
      { readBytes, write, mkdir, readdir },
      cpFlags(),
    )
    expect(files.get('/copy.txt')).toEqual(new Uint8Array([1]))
    expect(io.reads).toEqual({ '/a.txt': new Uint8Array([1]) })
    expect(io.cache).toEqual(['/a.txt'])
  })
})

interface PrimitiveFails {
  readFails?: Map<string, Error>
  writeFails?: Map<string, Error>
}

function makePrimitive(files: Map<string, Uint8Array>, dirs: Set<string>, fails: PrimitiveFails) {
  const { stat } = makeBackend(files, dirs)
  const readErr = fails.readFails ?? new Map<string, Error>()
  const writeErr = fails.writeFails ?? new Map<string, Error>()
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
  const strategy: PrimitiveCopy = { readBytes, write, mkdir, readdir }
  return { stat, strategy }
}

async function runPrimitive(
  files: Map<string, Uint8Array>,
  dirs: Set<string>,
  paths: string[],
  fails: PrimitiveFails = {},
  flags: CpFlags = cpFlags(),
): Promise<[ByteSource | null, IOResult]> {
  const { stat, strategy } = makePrimitive(files, dirs, fails)
  return cpGeneric(paths.map(spec), stat, strategy, flags)
}

describe('cpGeneric primitive transfer errors', () => {
  it('read failure reports cannot open and continues remaining sources', async () => {
    const files = new Map([
      ['/src/a.txt', new Uint8Array([1])],
      ['/src/b.txt', new Uint8Array([2])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [, io] = await runPrimitive(
      files,
      new Set(['/src', '/d']),
      ['/src/a.txt', '/src/b.txt', '/d'],
      { readFails: new Map([['/src/a.txt', eacces('/src/a.txt')]]) },
    )
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "cp: cannot open '/src/a.txt' for reading: Permission denied\n",
    )
    expect(files.has('/d/a.txt')).toBe(false)
    expect(files.get('/d/b.txt')).toEqual(new Uint8Array([2]))
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
      "cp: cannot create regular file '/d/a.txt': Operation not supported\n",
    )
    expect(files.get('/src/a.txt')).toEqual(new Uint8Array([1]))
    expect(Object.keys(io.writes)).toEqual([])
    expect(Object.keys(io.reads)).toEqual([])
  })

  it('recursive read failure still copies the rest of the tree', async () => {
    const files = new Map([
      ['/src/t/a.txt', new Uint8Array([1])],
      ['/src/t/nr.txt', new Uint8Array([2])],
    ])
    const dirs = new Set(['/src', '/src/t', '/d'])
    const [, io] = await runPrimitive(
      files,
      dirs,
      ['/src/t', '/d/t'],
      { readFails: new Map([['/src/t/nr.txt', eacces('/src/t/nr.txt')]]) },
      cpFlags({ recursive: true }),
    )
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "cp: cannot open '/src/t/nr.txt' for reading: Permission denied\n",
    )
    expect(files.get('/d/t/a.txt')).toEqual(new Uint8Array([1]))
    expect(files.has('/d/t/nr.txt')).toBe(false)
  })
})

const OLD = '2020-01-01T00:00:00+00:00'
const NEW = '2024-01-01T00:00:00+00:00'

function rootReaddir(files: Map<string, Uint8Array>, dirs: Set<string>): ReaddirFn {
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

describe('cpGeneric --update', () => {
  it('older skips a newer destination', async () => {
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
      flags: cpFlags({ update: 'older' }),
    })
    expect(io.exitCode).toBe(0)
    expect(io.stderr).toBeNull()
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
      flags: cpFlags({ update: 'older' }),
    })
    expect(files.get('/b.txt')).toEqual(new Uint8Array([1]))
  })

  it('older skips on equal mtimes', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const mtimes = new Map([
      ['/a.txt', OLD],
      ['/b.txt', OLD],
    ])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      mtimes,
      flags: cpFlags({ update: 'older' }),
    })
    expect(io.exitCode).toBe(0)
    expect(files.get('/b.txt')).toEqual(new Uint8Array([2]))
  })

  it('older replaces when mtimes are unknown', async () => {
    // Freshness cannot be proven without mtimes: the copy proceeds.
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(), ['/a.txt', '/b.txt'], { flags: cpFlags({ update: 'older' }) })
    expect(files.get('/b.txt')).toEqual(new Uint8Array([1]))
  })

  it('none skips silently', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: cpFlags({ update: 'none' }),
    })
    expect(io.exitCode).toBe(0)
    expect(io.stderr).toBeNull()
    expect(files.get('/b.txt')).toEqual(new Uint8Array([2]))
  })

  it('none-fail reports not replacing', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: cpFlags({ update: 'none-fail' }),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("cp: not replacing '/b.txt'\n")
    expect(files.get('/b.txt')).toEqual(new Uint8Array([2]))
  })
})

describe('cpGeneric --backup', () => {
  it('simple saves the old destination', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(), ['/a.txt', '/b.txt'], { flags: cpFlags({ backup: 'simple' }) })
    expect(files.get('/b.txt')).toEqual(new Uint8Array([1]))
    expect(files.get('/b.txt~')).toEqual(new Uint8Array([2]))
  })

  it('skips a missing destination', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    await run(files, new Set(), ['/a.txt', '/b.txt'], { flags: cpFlags({ backup: 'existing' }) })
    expect(files.get('/b.txt')).toEqual(new Uint8Array([1]))
    expect(files.has('/b.txt~')).toBe(false)
  })

  it('existing prefers numbered versions', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
      ['/b.txt.~3~', new Uint8Array([3])],
    ])
    await run(files, new Set(), ['/a.txt', '/b.txt'], {
      readdir: rootReaddir(files, new Set()),
      flags: cpFlags({ backup: 'existing' }),
    })
    expect(files.get('/b.txt.~4~')).toEqual(new Uint8Array([2]))
  })

  it('numbered starts at one', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(), ['/a.txt', '/b.txt'], {
      readdir: rootReaddir(files, new Set()),
      flags: cpFlags({ backup: 'numbered' }),
    })
    expect(files.get('/b.txt.~1~')).toEqual(new Uint8Array([2]))
  })

  it('honors a custom suffix', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: cpFlags({ backup: 'simple', suffix: '.bak' }),
    })
    expect(files.get('/b.txt.bak')).toEqual(new Uint8Array([2]))
  })

  it('records the backup write', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: cpFlags({ backup: 'simple' }),
    })
    expect(new Set(Object.keys(io.writes))).toEqual(new Set(['/b.txt', '/b.txt~']))
  })

  it('annotates the verbose line', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const [out] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: cpFlags({ verbose: true, backup: 'simple' }),
    })
    expect(DEC.decode((out as Uint8Array | null) ?? new Uint8Array())).toBe(
      "'/a.txt' -> '/b.txt' (backup: '/b.txt~')\n",
    )
  })

  it('a recursive merge backs up per file entry', async () => {
    const files = new Map([
      ['/src/f.txt', new Uint8Array([1])],
      ['/d/src/f.txt', new Uint8Array([2])],
    ])
    const dirs = new Set(['/src', '/d', '/d/src'])
    await runPrimitive(
      files,
      dirs,
      ['/src', '/d'],
      {},
      cpFlags({ recursive: true, verbose: true, backup: 'simple' }),
    )
    expect(files.get('/d/src/f.txt~')).toEqual(new Uint8Array([2]))
    expect(files.get('/d/src/f.txt')).toEqual(new Uint8Array([1]))
  })
})

describe('cpGeneric -t/-T', () => {
  it('copies into the target directory', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [, io] = await run(files, new Set(['/d']), ['/a.txt'], {
      flags: cpFlags({ targetDir: '/d' }),
    })
    expect(io.exitCode).toBe(0)
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
  })

  it('accepts the target directory as a PathSpec', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [, io] = await run(files, new Set(['/d']), ['/a.txt'], {
      flags: cpFlags({ targetDir: spec('/d') }),
    })
    expect(io.exitCode).toBe(0)
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
  })

  it('a missing target directory fails the whole command', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(), ['/a.txt'], {
      flags: cpFlags({ targetDir: '/nosuch' }),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("cp: target directory '/nosuch': No such file or directory\n")
    expect([...files.keys()]).toEqual(['/a.txt'])
  })

  it('a non-directory target directory fails the whole command', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/f.txt', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(), ['/a.txt'], {
      flags: cpFlags({ targetDir: '/f.txt' }),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("cp: target directory '/f.txt': Not a directory\n")
  })

  it('-T with three operands is an extra operand error', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
      ['/c.txt', new Uint8Array([3])],
    ])
    await expect(
      run(files, new Set(), ['/a.txt', '/b.txt', '/c.txt'], {
        flags: cpFlags({ noTargetDir: true }),
      }),
    ).rejects.toThrow("cp: extra operand '/c.txt'")
  })

  it('-T refuses a directory destination for a file', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/d/keep', new Uint8Array([9])],
    ])
    const [, io] = await run(files, new Set(['/d']), ['/a.txt', '/d'], {
      flags: cpFlags({ noTargetDir: true }),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "cp: cannot overwrite directory '/d' with non-directory '/a.txt'\n",
    )
  })

  it('refuses to overwrite a non-directory with a directory', async () => {
    const files = new Map([
      ['/f.txt', new Uint8Array([1])],
      ['/d/x.txt', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(['/d']), ['/d', '/f.txt'], { recursive: true })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "cp: cannot overwrite non-directory '/f.txt' with directory '/d'\n",
    )
  })

  it('missing operands raise usage errors', async () => {
    await expect(run(new Map(), new Set(), [])).rejects.toThrow('cp: missing file operand')
    await expect(
      run(new Map([['/a.txt', new Uint8Array([1])]]), new Set(), ['/a.txt']),
    ).rejects.toThrow("missing destination file operand after '/a.txt'")
  })
})

// Flag bags reach parseFlags through a spec-bound view, the way the
// builder and the crossmount relay build it.
function view(bag: Record<string, FlagValue>): FlagView {
  return new FlagView(bag, specOf('cp'))
}

describe('parseFlags', () => {
  it('rejects conflicting and invalid combinations', () => {
    expect(() => parseFlags(view({ backup: true, no_clobber: true }))).toThrow(
      'cp: --backup is mutually exclusive with -n or --update=none-fail',
    )
    expect(() => parseFlags(view({ backup: true, update: 'none-fail' }))).toThrow(
      'mutually exclusive',
    )
    expect(() => parseFlags(view({ target_directory: '/d', no_target_directory: true }))).toThrow(
      'cannot combine --target-directory (-t) and --no-target-directory (-T)',
    )
    expect(() => parseFlags(view({ update: 'bogus' }))).toThrow(
      "invalid argument 'bogus' for '--update'",
    )
    expect(() => parseFlags(view({ backup: 'bogus' }))).toThrow(
      "invalid argument 'bogus' for 'backup type'",
    )
  })

  it('resolves the GNU update and backup grammars', () => {
    expect(parseFlags(view({ update: true })).update).toBe('older')
    expect(parseFlags(view({ update: true })).update).toBe('older')
    expect(parseFlags(view({ update: 'all' })).update).toBe('all')
    expect(parseFlags(view({})).update).toBeNull()
    const parsed = parseFlags(view({ suffix: '.bak' }))
    expect(parsed.backup).toBe('existing')
    expect(parsed.suffix).toBe('.bak')
    // GNU 9.7: `cp --backup --suffix= f g` writes g~, so an empty suffix
    // reads as absent rather than naming the original as its own backup.
    expect(parseFlags(view({ backup: true, suffix: '' })).suffix).toBe('~')
    expect(parseFlags(view({ backup: 't' })).backup).toBe('numbered')
    expect(parseFlags(view({ backup: 'nil' })).backup).toBe('existing')
    expect(parseFlags(view({ archive: true })).recursive).toBe(true)
  })
})

// Backend whose find honors `type` and whose mkdir records directories.
function typedBackend(files: Map<string, Uint8Array>, dirs: Set<string>) {
  const { stat, copy } = makeBackend(files, dirs)
  const find = (p: PathSpec, options: FindOptions): Promise<string[]> => {
    const base = key(p) + '/'
    const source = options.type === 'd' ? [...dirs] : [...files.keys()]
    return Promise.resolve(source.filter((k) => k.startsWith(base)).sort())
  }
  const mkdir = (p: PathSpec): Promise<void> => {
    dirs.add(key(p))
    return Promise.resolve()
  }
  return { stat, copy, find, mkdir }
}

describe('per-entry policy still materializes directories', () => {
  it('keeps a directory that holds no files under -r -u', async () => {
    const files = new Map([['/t/f.txt', new Uint8Array([70])]])
    const dirs = new Set(['/t', '/t/empt'])
    const { stat, copy, find, mkdir } = typedBackend(files, dirs)
    const [, io] = await cpGeneric(
      ['/t', '/c'].map(spec),
      stat,
      { copy, find, mkdir },
      cpFlags({ recursive: true, update: 'older' }),
    )
    expect(io.exitCode).toBe(0)
    expect(files.get('/c/f.txt')).toEqual(new Uint8Array([70]))
    expect(dirs.has('/c/empt')).toBe(true)
  })

  it('creates the destination for an entirely empty tree', async () => {
    const files = new Map<string, Uint8Array>()
    const dirs = new Set(['/t', '/t/a', '/t/a/b'])
    const { stat, copy, find, mkdir } = typedBackend(files, dirs)
    const [, io] = await cpGeneric(
      ['/t', '/c'].map(spec),
      stat,
      { copy, find, mkdir },
      cpFlags({ recursive: true, backup: 'simple' }),
    )
    expect(io.exitCode).toBe(0)
    expect(dirs.has('/c')).toBe(true)
    expect(dirs.has('/c/a/b')).toBe(true)
  })

  it('keeps the native dirCopy for the no-op policy modes', async () => {
    // --update=all and --backup=none decide nothing per entry.
    for (const flags of [
      cpFlags({ recursive: true, update: 'all' }),
      cpFlags({ recursive: true, backup: 'none' }),
    ]) {
      const files = new Map([['/t/f.txt', new Uint8Array([70])]])
      const dirs = new Set(['/t', '/t/empt'])
      const { stat, copy, find, mkdir } = typedBackend(files, dirs)
      let used = false
      const dirCopy = (_src: PathSpec, dst: PathSpec): Promise<void> => {
        used = true
        dirs.add(key(dst))
        return Promise.resolve()
      }
      const [, io] = await cpGeneric(
        ['/t', '/c'].map(spec),
        stat,
        { copy, find, dirCopy, mkdir },
        flags,
      )
      expect(io.exitCode).toBe(0)
      expect(used).toBe(true)
    }
  })
})

describe('backup version scan failures', () => {
  it('aborts the overwrite instead of degrading to .~1~', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([78])],
      ['/b.txt', new Uint8Array([79])],
    ])
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      flags: cpFlags({ backup: 'numbered' }),
      readdir: () => Promise.reject(enotsup('ram', 'readdir', '/')),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain("cp: cannot backup '/b.txt': Operation not supported")
    expect(files.get('/b.txt')).toEqual(new Uint8Array([79]))
  })
})

// The per-operand probes answer "is this path there?". A stat that fails for
// any other reason is not an answer, and must not be read as one: returning
// "missing" would let -n overwrite the very target it exists to protect.
// Python's twins narrow to (FileNotFoundError, ValueError) in all three.
// Exercised directly, because whichever probe runs first would otherwise
// mask the others.
describe('cp probes propagate non-missing stat failures', () => {
  const boom: StatFn = () => Promise.reject(new Error('401 Unauthorized'))
  const missing: StatFn = (p) => Promise.reject(enoent(key(p)))

  it('overwriteGate rethrows instead of reporting "safe to overwrite"', async () => {
    const policy = { cmdName: 'cp', noClobber: true, update: null, backup: null, suffix: '~' }
    await expect(overwriteGate(policy, boom, spec('/a.txt'), spec('/dst.txt'), [])).rejects.toThrow(
      '401 Unauthorized',
    )
    // A genuinely missing target still means "nothing to clobber".
    expect(await overwriteGate(policy, missing, spec('/a.txt'), spec('/dst.txt'), [])).toBe(true)
  })

  it('entryKind rethrows instead of reporting the path as absent', async () => {
    await expect(entryKind(boom, spec('/a.txt'))).rejects.toThrow('401 Unauthorized')
    expect(await entryKind(missing, spec('/a.txt'))).toEqual({ exists: false, isDir: false })
  })

  it('targetDirError rethrows instead of claiming No such file or directory', async () => {
    await expect(targetDirError('cp', boom, spec('/d'))).rejects.toThrow('401 Unauthorized')
    expect(await targetDirError('cp', missing, spec('/d'))).toBe(
      "cp: target directory '/d': No such file or directory",
    )
  })
})
