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
import { type ByteSource, IOResult } from '../../../io/types.ts'
import {
  ContentType,
  LINK_TARGET_KEY,
  FileStat,
  FileType,
  PathSpec,
  type PrimitiveCopy,
  type ReaddirFn,
  type StatFn,
} from '../../../types.ts'
import type { FindOptions } from '../../../vfs/types.ts'
import { eacces, enoent, enotsup } from '../../../errors/fs.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import {
  cpFlags,
  cpGeneric,
  overwriteGate,
  parseFlags,
  targetDirError,
  updateMode,
  type CpFlags,
  type TransferLinks,
} from './cp.ts'
import { entryKind } from '../utils/paths.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'
import { SPECS, parseCommand } from '../../spec/index.ts'
import { parseToKwargs } from '../../spec/parser.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

const DEC = new TextDecoder()

function key(p: PathSpec | string): string {
  return rstripSlash(typeof p === 'string' ? p : p.virtual)
}

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    vfsPath: mountKey(path, ''),
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
  it('deep under a plain file still reports Not a directory', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/plain', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(['/']), ['/a.txt', '/plain/s/x.txt'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("cp: cannot stat '/plain/s/x.txt': Not a directory\n")
  })

  it('a SOURCE deep under a plain file reports Not a directory', async () => {
    const files = new Map([['/plain', new Uint8Array([2])]])
    const [, io] = await run(files, new Set(['/', '/d']), ['/plain/a/b', '/d'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("cp: cannot stat '/plain/a/b': Not a directory\n")
  })

  it('multiple sources with a slashed plain-file target report Not a directory', async () => {
    // GNU 9.7: `cp a b reg/` is `target 'reg/': Not a directory`, the
    // destination probe's verdict, where only a genuinely absent target is
    // `No such file or directory`.
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
      ['/reg', new Uint8Array([3])],
    ])
    const { stat, copy, find } = makeBackend(files, new Set())
    await expect(
      cpGeneric(
        [spec('/a.txt'), spec('/b.txt'), slashed('/reg')],
        stat,
        { copy, find },
        cpFlags({}),
      ),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(
      cpGeneric(
        [spec('/a.txt'), spec('/b.txt'), slashed('/missing')],
        stat,
        { copy, find },
        cpFlags({}),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect([...files.keys()].sort()).toEqual(['/a.txt', '/b.txt', '/reg'])
  })

  it('refuses the same file via a directory target', async () => {
    const files = new Map([['/d/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(['/d']), ['/d/a.txt', '/d'])
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain('are the same file')
  })

  it('refuses recursive copy into a nested subtree', async () => {
    const files = new Map([['/d/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(['/d', '/d/sub']), ['/d', '/d/sub'], {
      recursive: true,
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toContain('into itself')
    expect([...files.keys()]).toEqual(['/d/a.txt', '/d/sub/d/a.txt'])
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

  it('no-clobber with duplicate basenames keeps the first', async () => {
    const files = new Map([
      ['/x/a.txt', new Uint8Array([1])],
      ['/y/a.txt', new Uint8Array([2])],
    ])
    await run(files, new Set(['/d']), ['/x/a.txt', '/y/a.txt', '/d'], { no_clobber: true })
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
  })

  it('duplicate basenames keep the first copy', async () => {
    const files = new Map([
      ['/x/a.txt', new Uint8Array([1])],
      ['/y/a.txt', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(['/d']), ['/x/a.txt', '/y/a.txt', '/d'])
    expect(files.get('/d/a.txt')).toEqual(new Uint8Array([1]))
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(
      "cp: will not overwrite just-created '/d/a.txt' with '/y/a.txt'\n",
    )
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
  // Freshness cannot be proven without mtimes: the copy proceeds.
  it.each([
    ['older', OLD, 2],
    ['older', undefined, 1],
    ['none', undefined, 2],
  ] as const)('%s with mtime %s keeps byte %d', async (update, stamp, kept) => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/b.txt', new Uint8Array([2])],
    ])
    const stamps: [string, string][] =
      stamp === undefined
        ? []
        : [
            ['/a.txt', stamp],
            ['/b.txt', stamp],
          ]
    const [, io] = await run(files, new Set(), ['/a.txt', '/b.txt'], {
      mtimes: new Map(stamps),
      flags: cpFlags({ update }),
    })
    expect([io.exitCode, io.stderr]).toEqual([0, null])
    expect(files.get('/b.txt')).toEqual(new Uint8Array([kept]))
  })
})

describe('cpGeneric --backup', () => {
  it.each([
    [{}, {}],
    [
      { '/b.txt': 2, '/b.txt.~3~': 3 },
      { '/b.txt.~3~': 3, '/b.txt.~4~': 2 },
    ],
  ] as [Record<string, number>, Record<string, number>][])(
    'existing follows the numbered versions of %j',
    async (before, backups) => {
      const files = new Map(
        Object.entries({ '/a.txt': 1, ...before }).map(([path, byte]) => [
          path,
          new Uint8Array([byte]),
        ]),
      )
      await run(files, new Set(), ['/a.txt', '/b.txt'], {
        readdir: rootReaddir(files, new Set()),
        flags: cpFlags({ backup: 'existing' }),
      })
      expect(Object.fromEntries([...files].map(([path, data]) => [path, data[0]]))).toEqual({
        '/a.txt': 1,
        '/b.txt': 1,
        ...backups,
      })
    },
  )

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

  it('a non-directory target directory fails the whole command', async () => {
    const files = new Map([
      ['/a.txt', new Uint8Array([1])],
      ['/f.txt', new Uint8Array([2])],
    ])
    const [, io] = await run(files, new Set(), ['/a.txt'], {
      flags: cpFlags({ targetDir: PathSpec.fromStrPath('/f.txt') }),
    })
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe("cp: target directory '/f.txt': Not a directory\n")
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
    expect(() => parseFlags(view({ backup: true, update: 'none-fail' }))).toThrow(
      'mutually exclusive',
    )
  })

  // `n` is a prefix of `none` and of `none-fail`, which are two values, so
  // 9.7 refuses it rather than reading it as `none`.
  it.each(['n', 'no', 'non'])('refuses the --update prefix %s as ambiguous', (value) => {
    expect(() => parseFlags(view({ update: value }))).toThrow(
      `ambiguous argument '${value}' for '--update'`,
    )
  })

  it('resolves the GNU update and backup grammars', () => {
    expect(parseFlags(view({})).update).toBeNull()
    expect(parseFlags(view({ backup: 't' })).backup).toBe('numbered')
    expect(parseFlags(view({ backup: 'nil' })).backup).toBe('existing')
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

// Both of cp's argument clauses name the refused word through gnulib's
// quote(), so a byte outside 0x20-0x7e comes back escaped rather than
// interpolated raw. Every row measured against GNU coreutils 9.4 under
// `LC_ALL=C` with a raw `bytes` argv (`cp --update=<w>`,
// `cp --backup=<w>`). Mirrors test_cp.py.
describe('cp quotes the word its argument clauses name', () => {
  const words: [string, string][] = [
    ['xé', 'x\\303\\251'],
    ['x\r', 'x\\r'],
    ['x\x01', 'x\\001'],
    ['x\x7f', 'x\\177'],
    ["x'", "x\\'"],
    ['x\\', 'x\\\\'],
  ]

  describe.each([
    ['update', '--update'],
    ['backup', 'backup type'],
  ])('in the --%s clause', (flag, clause) => {
    it.each(words)('escapes %j', (value, escaped) => {
      let message = ''
      try {
        parseFlags(view({ [flag]: value }))
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message.startsWith(`cp: invalid argument '${escaped}' for '${clause}'\n`)).toBe(true)
    })
  })
})

// Measured against GNU coreutils 9.7 on debian:stable-slim, LC_ALL=C.
describe('--update candidates', () => {
  it.each([
    ['cp', 'older', 'older'],
    ['cp', 'a', 'all'],
    ['cp', 'o', 'older'],
    ['cp', 'old', 'older'],
    ['mv', 'all', 'all'],
    ['mv', 'older', 'older'],
    ['mv', 'a', 'all'],
    ['mv', 'al', 'all'],
    ['mv', 'o', 'older'],
    ['mv', 'old', 'older'],
    ['mv', 'none-', 'none-fail'],
  ])('%s accepts %s as %s', (command, value, mode) => {
    expect(updateMode(command, new FlagView({ update: value }, specOf(command)))).toBe(mode)
  })
})

// The operand as the shell classifies `path/`: a normalized virtual path
// with the typed spelling, slash included, kept in rawPath.
function slashed(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path.slice(0, path.lastIndexOf('/')) || '/',
    resolved: false,
    vfsPath: mountKey(path, ''),
    rawPath: `${path}/`,
  })
}

describe('the link options', () => {
  function flagsOf(...argv: string[]): CpFlags {
    const spec = SPECS.cp
    if (spec === undefined) throw new Error('no cp spec')
    const words = [...argv, '/data/a', '/data/b']
    return parseFlags(new FlagView(parseToKwargs(parseCommand(spec, words, '/', 'cp')), spec))
  }

  // cp.c: -L, -P, -H, -d and -a each set the dereference policy, so the last
  // one wins; with none, a recursive copy copies links as links and any other
  // copy follows them. Mirrors test_cp.py.
  it.each([
    [['-R'], 'never'],
    [['-a'], 'never'],
    [['-d'], 'never'],
    [['-L', '-P'], 'never'],
    [['-P', '-L'], 'always'],
    [['-a', '-L'], 'always'],
  ] as const)('reads %j as %s', (argv, deref) => {
    expect(flagsOf(...argv).dereference).toBe(deref)
  })
})

describe('a link reached through a linked directory', () => {
  // The table keys a link by its resolved directory, so `dl/al` stands at
  // `dir/al`; coreutils 9.7 copies the link itself. Mirrors python's
  // test_a_link_reached_through_a_linked_directory_copies_as_a_link.
  it('cp -P copies it as a link', async () => {
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    await ws.shell(
      "cd /data && mkdir dir w && printf 'x\\n' > a.txt && ln -s ../a.txt dir/al && ln -s dir dl",
    )
    const r = await ws.shell('cd /data && cp -P dl/al w/x && ls -F w')
    expect([r.exitCode, DEC.decode(r.stdout)]).toEqual([0, 'x@\n'])
    await ws.close()
  })
})

for (const native of [false, true]) {
  for (const failure of ['read', 'write', 'partial-write']) {
    it.each(['/safe', '/missing', '/dst~'])(
      `failed ${native ? 'native' : 'primitive'} backup ${failure} restores link to %s`,
      async (referent) => {
        const enc = new TextEncoder()
        const files = new Map<string, Uint8Array>([
          ['/src', enc.encode('new')],
          ['/dst', enc.encode('old')],
          ['/safe', enc.encode('safe')],
        ])
        const original = new Map(files)
        const links = new Map([['/dst~', referent]])
        const { stat, find } = makeBackend(files, new Set())
        const read = (path: PathSpec): Promise<Uint8Array> => {
          if (failure === 'read' && path.virtual === '/dst') throw eacces(path.virtual)
          const data = files.get(path.virtual)
          if (data === undefined) throw enoent(path.virtual)
          return Promise.resolve(data)
        }
        const write = (path: PathSpec, data: Uint8Array): Promise<void> => {
          if (path.virtual === '/dst~') {
            if (failure === 'partial-write') files.set(path.virtual, enc.encode('partial'))
            throw eacces(path.virtual)
          }
          files.set(path.virtual, data)
          return Promise.resolve()
        }
        const primitive: PrimitiveCopy = {
          readBytes: read,
          write,
          mkdir: (path) => {
            expect(files.has(path.virtual)).toBe(false)
            return Promise.resolve()
          },
          readdir: (path) =>
            Promise.resolve(
              [...files.keys(), ...links.keys()].filter((p) => p.startsWith(path.virtual)),
            ),
        }
        const copies: TransferLinks = {
          cwd: '/',
          relay: primitive,
          relayStat: stat,
          links: {
            statAt: (path) =>
              links.has(path)
                ? new FileStat({
                    name: path,
                    type: FileType.SYMLINK,
                    extra: { [LINK_TARGET_KEY]: links.get(path) ?? '' },
                  })
                : null,
            children: (path) =>
              [...links.keys()]
                .filter((p) => p.startsWith(path))
                .flatMap((p) => {
                  const row = copies.links.statAt(p)
                  return row === null ? [] : [row]
                }),
            subtree: (path) =>
              [...links.keys()]
                .filter((p) => p.startsWith(path))
                .flatMap((p): [string, FileStat][] => {
                  const row = copies.links.statAt(p)
                  return row === null ? [] : [[p, row]]
                }),
            resolve: (path) => links.get(path) ?? path,
            exists: (path) => Promise.resolve(files.has(path)),
            targetStat: (path) => stat(spec(links.get(path) ?? path)),
          },
          dispatch: (op, path, _args, kwargs = {}) => {
            if (op === 'unlink') {
              if (!links.delete(path.virtual)) files.delete(path.virtual)
            } else if (op === 'symlink') {
              expect(files.has(path.virtual)).toBe(false)
              links.set(path.virtual, String(kwargs.target))
            } else throw new Error(`unexpected op: ${op}`)
            return Promise.resolve([null, new IOResult()])
          },
        }
        const strategy = native
          ? { copy: async (src: PathSpec, dst: PathSpec) => write(dst, await read(src)), find }
          : primitive
        const [, io] = await cpGeneric(
          [spec('/src'), spec('/dst')],
          stat,
          strategy,
          cpFlags({ backup: 'simple' }),
          undefined,
          undefined,
          undefined,
          undefined,
          copies,
        )
        expect(io.exitCode).toBe(1)
        expect(await io.stderrStr()).toBe("cp: cannot backup '/dst': Permission denied\n")
        expect(io.writes).toEqual({})
        expect(links).toEqual(new Map([['/dst~', referent]]))
        expect(files).toEqual(original)
      },
    )
  }
}

it('cp -rL omits hidden links', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS(), '/other': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    await ws.shell(
      'mkdir -p /data/src/sec && echo visible > /data/src/a && ' +
        'ln -s a /data/src/public && ln -s /private/key /data/src/secret && ' +
        'ln -s /private/nested /data/src/sec/link',
    )
    ws.createSession('agent', {
      profile: { paths: { hide: ['/data/src/secret', '/data/src/sec'] } },
    })
    const result = await ws.shell('cp -rL /data/src /other/copy', { sessionId: 'agent' })
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stderr)).toBe('')
    const copied = await ws.shell('ls -A /other/copy && cat /other/copy/public')
    expect(DEC.decode(copied.stdout)).toBe('a\npublic\nvisible\n')
    expect(ws.namespace.isLink('/other/copy/secret')).toBe(false)
    expect(ws.namespace.isLink('/other/copy/sec/link')).toBe(false)
  } finally {
    await ws.close()
  }
})
