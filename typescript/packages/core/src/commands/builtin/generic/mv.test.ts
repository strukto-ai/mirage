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
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
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
    vfsPath: mountKey(path, ''),
  })
}

function slashed(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path.slice(0, path.lastIndexOf('/')) || '/',
    resolved: false,
    vfsPath: mountKey(path, ''),
    rawPath: `${path}/`,
  })
}

function fileMap(entries: Record<string, number>): Map<string, Uint8Array> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, new Uint8Array([v])]))
}

function contents(files: Map<string, Uint8Array>): Record<string, number | undefined> {
  return Object.fromEntries([...files].map(([k, v]) => [k, v[0]]))
}

function makeBackend(files: Map<string, Uint8Array>, dirs: Set<string>) {
  const stat = (p: PathSpec): Promise<FileStat> => {
    const k = key(p)
    if (dirs.has(k)) {
      return Promise.resolve(
        new FileStat({ name: k.split('/').pop() ?? '', type: FileType.DIRECTORY }),
      )
    }
    if (!files.has(k)) return Promise.reject(enoent(k))
    return Promise.resolve(
      new FileStat({
        name: k.split('/').pop() ?? '',
        type: FileType.FILE,
        content: ContentType.TEXT,
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
  readdir?: ReaddirFn
}

async function run(
  files: Map<string, Uint8Array>,
  dirs: Set<string>,
  paths: string[],
  opts: RunOpts = {},
): Promise<[ByteSource | null, IOResult]> {
  const { stat, rename } = makeBackend(files, dirs)
  const flags =
    opts.flags ?? mvFlags({ noClobber: opts.no_clobber === true, verbose: opts.verbose === true })
  return mvGeneric(paths.map(spec), stat, { rename }, flags, undefined, undefined, opts.readdir)
}

describe('mvGeneric guards', () => {
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

  it.each([
    [spec('/dst.txt'), 'ENOTDIR'],
    [slashed('/missing'), 'ENOENT'],
  ])('refuses many sources onto %s as %s', async (target, code) => {
    const files = fileMap({ '/a.txt': 1, '/b.txt': 2, '/dst.txt': 3, '/reg': 4 })
    const { stat, rename } = makeBackend(files, new Set())
    await expect(
      mvGeneric([spec('/a.txt'), spec('/b.txt'), target], stat, { rename }, mvFlags({})),
    ).rejects.toMatchObject({ code })
    expect(contents(files)).toEqual({ '/a.txt': 1, '/b.txt': 2, '/dst.txt': 3, '/reg': 4 })
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

const TWO = { '/src/a.txt': 1, '/src/b.txt': 2, '/d/keep': 9 }
const TWO_MOVED = { '/src/a.txt': 1, '/d/keep': 9, '/d/a.txt': 1, '/d/b.txt': 2 }
const DENIED_A = "mv: cannot remove '/src/a.txt': Permission denied\n"

function unsup(op: string, ...paths: string[]): Map<string, Error> {
  return new Map(paths.map((p) => [p, enotsup('email', op, p)]))
}

describe('mvGeneric records writes', () => {
  it.each([
    {
      name: 'a native move into a directory',
      primitive: false,
      files: { '/a.txt': 1, '/d/keep': 9 },
      dirs: ['/d'],
      paths: ['/a.txt', '/d'],
      exit: 0,
      writes: ['/a.txt', '/d/a.txt'],
    },
    {
      name: 'a move across backends',
      primitive: true,
      files: { '/src/a.txt': 1, '/d/keep': 9 },
      dirs: ['/src', '/d'],
      paths: ['/src/a.txt', '/d'],
      exit: 0,
      writes: ['/src/a.txt', '/d/a.txt'],
    },
    {
      name: 'an unsupported unlink',
      primitive: true,
      files: { '/src/a.txt': 1, '/d/keep': 9 },
      dirs: ['/src', '/d'],
      paths: ['/src/a.txt', '/d'],
      fails: { unlinkFails: unsup('unlink', '/src/a.txt') },
      exit: 1,
      writes: ['/d/a.txt'],
    },
    {
      name: 'a failed read',
      primitive: true,
      files: { '/src/a.txt': 1, '/d/keep': 9 },
      dirs: ['/src', '/d'],
      paths: ['/src/a.txt', '/d'],
      fails: { readFails: new Map([['/src/a.txt', eacces('/src/a.txt')]]) },
      exit: 1,
      writes: [],
    },
    {
      name: 'a backup',
      primitive: false,
      files: { '/a.txt': 1, '/b.txt': 2 },
      dirs: [],
      paths: ['/a.txt', '/b.txt'],
      flags: mvFlags({ backup: 'simple' }),
      exit: 0,
      writes: ['/a.txt', '/b.txt', '/b.txt~'],
    },
    {
      name: 'an exchange',
      primitive: false,
      files: { '/a.txt': 1, '/b.txt': 2 },
      dirs: [],
      paths: ['/a.txt', '/b.txt'],
      flags: mvFlags({ exchange: true }),
      exit: 0,
      writes: ['/a.txt', '/b.txt'],
    },
  ])('for $name', async ({ primitive, files, dirs, paths, flags, fails, exit, writes }) => {
    const [, io] = primitive
      ? await runPrimitive(fileMap(files), new Set(dirs), paths, fails)
      : await run(fileMap(files), new Set(dirs), paths, flags === undefined ? {} : { flags })
    expect(io.exitCode).toBe(exit)
    expect(new Set(Object.keys(io.writes))).toEqual(new Set(writes))
  })
})

describe('mvGeneric primitive transfer errors', () => {
  it.each([
    {
      name: 'an unlink failure keeps moving the remaining sources',
      files: TWO,
      dirs: ['/src', '/d'],
      paths: ['/src/a.txt', '/src/b.txt', '/d'],
      fails: { unlinkFails: new Map([['/src/a.txt', eacces('/src/a.txt')]]) },
      exit: 1,
      out: null,
      err: DENIED_A,
      after: TWO_MOVED,
    },
    {
      name: 'verbose lists only the moves that fully completed',
      files: TWO,
      dirs: ['/src', '/d'],
      paths: ['/src/a.txt', '/src/b.txt', '/d'],
      fails: { unlinkFails: new Map([['/src/a.txt', eacces('/src/a.txt')]]) },
      flags: mvFlags({ verbose: true }),
      exit: 1,
      out: "renamed '/src/b.txt' -> '/d/b.txt'\n",
      err: DENIED_A,
      after: TWO_MOVED,
    },
    {
      name: 'a read failure reports cannot open and keeps the source',
      files: { '/src/a.txt': 1, '/d/keep': 9 },
      dirs: ['/src', '/d'],
      paths: ['/src/a.txt', '/d'],
      fails: { readFails: new Map([['/src/a.txt', eacces('/src/a.txt')]]) },
      exit: 1,
      out: null,
      err: "mv: cannot open '/src/a.txt' for reading: Permission denied\n",
      after: { '/src/a.txt': 1, '/d/keep': 9 },
    },
    {
      name: 'a tree unlink failure reports files, never ancestor dirs',
      files: { '/src/t/a.txt': 1, '/src/t/sub/b.txt': 2 },
      dirs: ['/src', '/src/t', '/src/t/sub', '/d'],
      paths: ['/src/t', '/d/t'],
      fails: {
        unlinkFails: unsup('unlink', '/src/t/a.txt', '/src/t/sub/b.txt'),
        rmdirFails: unsup('rmdir', '/src/t', '/src/t/sub'),
      },
      exit: 1,
      out: null,
      err:
        "mv: cannot remove '/src/t/sub/b.txt': Operation not supported\n" +
        "mv: cannot remove '/src/t/a.txt': Operation not supported\n",
      after: { '/src/t/a.txt': 1, '/src/t/sub/b.txt': 2, '/d/t/a.txt': 1, '/d/t/sub/b.txt': 2 },
    },
    {
      name: 'a tree copy failure keeps the whole source and skips removal',
      files: { '/src/t/a.txt': 1, '/src/t/nr.txt': 2 },
      dirs: ['/src', '/src/t', '/d'],
      paths: ['/src/t', '/d/t'],
      fails: { readFails: new Map([['/src/t/nr.txt', eacces('/src/t/nr.txt')]]) },
      exit: 1,
      out: null,
      err: "mv: cannot open '/src/t/nr.txt' for reading: Permission denied\n",
      after: { '/src/t/a.txt': 1, '/src/t/nr.txt': 2, '/d/t/a.txt': 1 },
    },
    {
      name: 'an unsupported rmdir on an emptied dir is a completed removal',
      files: { '/src/t/x.txt': 1, '/d/keep': 9 },
      dirs: ['/src', '/src/t', '/d'],
      paths: ['/src/t', '/d'],
      fails: { rmdirFails: new Map([['/src/t', enotsup('hf', 'rmdir', '/src/t')]]) },
      exit: 0,
      out: null,
      err: '',
      after: { '/d/keep': 9, '/d/t/x.txt': 1 },
    },
  ])('$name', async ({ files, dirs, paths, fails, flags, exit, out, err, after }) => {
    const map = fileMap(files)
    const [stdout, io] = await runPrimitive(map, new Set(dirs), paths, fails, flags)
    expect(io.exitCode).toBe(exit)
    expect(stdout === null ? null : DEC.decode(stdout as Uint8Array)).toBe(out)
    expect(await io.stderrStr()).toBe(err)
    expect(contents(map)).toEqual(after)
  })
})

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

describe('mvGeneric -t/-T', () => {
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

  it('a missing target directory fails the whole command', async () => {
    const files = new Map([['/a.txt', new Uint8Array([1])]])
    const [, io] = await run(files, new Set(), ['/a.txt'], {
      flags: mvFlags({ targetDir: PathSpec.fromStrPath('/nosuch') }),
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
    expect(() => parseFlags(view({ backup: true, no_clobber: true }))).toThrow(
      'mv: cannot combine --backup with --exchange, -n, or --update=none-fail',
    )
  })

  it('resolves the update and exchange grammars', () => {
    const parsed = parseFlags(view({ update: true, exchange: true }))
    expect(parsed.update).toBe('older')
    expect(parsed.exchange).toBe(true)
  })
})

describe('mv --exchange staging safety', () => {
  it.each([
    {
      name: 'rolls the operands back when a later rename fails',
      fails: (n: number) => n === 2,
      err: "mv: cannot exchange '/a.txt' and '/b.txt': Permission denied\n",
      after: { '/a.txt': 65, '/b.txt': 66 },
    },
    {
      name: 'reports the leftover staging path when the rollback also fails',
      fails: (n: number) => n >= 2,
      err:
        "mv: cannot exchange '/a.txt' and '/b.txt': Permission denied\n" +
        "mv: '/a.txt' left at '/b.txt.~xchg~' after a failed exchange\n",
      after: { '/b.txt': 66, '/b.txt.~xchg~': 65 },
    },
  ])('$name', async ({ fails, err, after }) => {
    const files = fileMap({ '/a.txt': 65, '/b.txt': 66 })
    const { stat, rename } = makeBackend(files, new Set())
    let calls = 0
    const flaky = (src: PathSpec, dst: PathSpec): Promise<void> => {
      calls += 1
      if (fails(calls)) return Promise.reject(eacces(dst.virtual))
      return rename(src, dst)
    }
    const [, io] = await mvGeneric(
      ['/a.txt', '/b.txt'].map(spec),
      stat,
      { rename: flaky },
      mvFlags({ exchange: true }),
    )
    expect(io.exitCode).toBe(1)
    expect(await io.stderrStr()).toBe(err)
    expect(contents(files)).toEqual(after)
  })
})

describe('mv -b -T over a nonempty directory', () => {
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
