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
import { FileStat, FileType, MountMode, PathSpec } from '../../../types.ts'
import { runWithMountGate } from '../../../context/session_context.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { IOResult } from '../../../io/types.ts'
import { Files } from '../../../workspace/files.ts'
import { parseFlags, segmentsMatch, treeGeneric as generic, type TreeFlags } from './tree.ts'
import { specOf } from '../../spec/builtins.ts'
import { parseFlags as parseLineFlags } from '../../../workspace/executor/command/flags.ts'
import { readers } from '../../../test-utils.ts'

const DEC = new TextDecoder()

type Operands<T> = T extends [unknown, ...infer R] ? R : never

// tree as its builder runs it: the options read first, a refusal returned.
async function treeGeneric(
  ...args: Operands<Parameters<typeof generic>>
): Promise<CommandFnResult> {
  const parsed = parseFlags(args[1].flags)
  if (parsed instanceof IOResult) return [null, parsed]
  return generic(parsed, ...args)
}

const FOLDERS = new Set(['/', '/docs', '/.secret'])

function key(p: PathSpec): string {
  return rstripSlash(p.virtual) || '/'
}

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    vfsPath: mountKey(path, ''),
  })
}

function ctx(flags: Record<string, string | boolean | number | string[]>): Context {
  return {
    stdin: null,
    flags,
    cwd: PathSpec.fromStrPath('/'),
  } as unknown as Context
}

const stat = (p: PathSpec): Promise<FileStat> =>
  Promise.resolve(
    new FileStat({
      name: key(p).split('/').pop() ?? '',
      type: FOLDERS.has(key(p)) ? FileType.DIRECTORY : FileType.FILE,
    }),
  )

const boxReaddir = (p: PathSpec): Promise<string[]> => {
  const k = key(p)
  if (k === '/') return Promise.resolve(['/docs/', '/readme.txt', '/.secret/'])
  if (k === '/docs') return Promise.resolve(['/docs/a.txt'])
  return Promise.resolve([])
}

const s3Readdir = (p: PathSpec): Promise<string[]> => {
  const k = key(p)
  if (k === '/') return Promise.resolve(['/docs', '/readme.txt', '/.secret'])
  if (k === '/docs') return Promise.resolve(['/docs/a.txt'])
  return Promise.resolve([])
}

async function run(
  readdir: (p: PathSpec) => Promise<string[]>,
  flags: Record<string, string | boolean | number | string[]>,
): Promise<string> {
  const [out] = (await treeGeneric([spec('/')], ctx(flags), readdir, stat)) as [Uint8Array, unknown]
  return DEC.decode(out)
}

describe('treeGeneric with trailing-slash folder entries', () => {
  it.each([
    ['slash-suffixed', boxReaddir],
    ['slash-free', s3Readdir],
  ])('draws %s folder entries by name', async (_shape, readdir) => {
    expect(await run(readdir, {})).toBe(
      '/\n|-- docs\n|   `-- a.txt\n`-- readme.txt\n\n2 directories, 2 files\n',
    )
    expect(await run(readdir, { a: true })).toBe(
      '/\n|-- .secret\n|-- docs\n|   `-- a.txt\n`-- readme.txt\n\n3 directories, 2 files\n',
    )
  })
})

describe('treeGeneric operand that is not a directory', () => {
  function optsWith(start: FileStat | null): Context {
    const dispatch: DispatchFn = () => Promise.resolve([start, new IOResult()])
    return {
      stdin: null,
      flags: {},
      cwd: PathSpec.fromStrPath('/'),
      vfs: new Files(dispatch, null, null, { ledger: false }),
    } as unknown as Context
  }

  const unreached = (): Promise<never> => {
    throw new Error('a non-directory operand must not be listed')
  }

  it('counts no bytes for a missing path', async () => {
    const [out, io] = (await treeGeneric(
      [spec('/gone')],
      { ...optsWith(null), flags: { du: true } } as unknown as Context,
      unreached,
      unreached,
    )) as [Uint8Array, IOResult]
    expect(DEC.decode(out).trimEnd().split('\n').pop()?.trim()).toBe(
      '0 bytes used in 0 directories, 0 files',
    )
    expect(io.exitCode).toBe(2)
  })

  // An unreadable directory that does exist still reaches the walk, which
  // renders the same marker with exit 2 (a permission error, not absence).
  it('still walks a directory it cannot list', async () => {
    const dirStat = new FileStat({ name: 'locked', type: FileType.DIRECTORY })
    const failing = (): Promise<string[]> => {
      const err = new Error('/locked') as Error & { code: string }
      err.code = 'EACCES'
      return Promise.reject(err)
    }
    const [out, io] = (await treeGeneric(
      [spec('/locked')],
      optsWith(dirStat),
      failing,
      unreached,
    )) as [Uint8Array, { exitCode: number }]
    expect(io.exitCode).toBe(2)
    expect(DEC.decode(out)).toBe('/locked  [error opening dir]\n\n0 directories, 0 files\n')
  })

  // tree 2.2.1 on a readable directory without search permission lists its
  // names, stats none, and draws the root plainly with exit 0. Mirrors
  // test_tree.py.
  it('draws a root whose entries all fail to stat plainly', async () => {
    const dirStat = new FileStat({ name: 'r', type: FileType.DIRECTORY })
    const denied = (): Promise<never> => {
      const err = new Error('/r/x') as Error & { code: string }
      err.code = 'EACCES'
      return Promise.reject(err)
    }
    const [out, io] = (await treeGeneric(
      [spec('/r')],
      optsWith(dirStat),
      () => Promise.resolve(['/r/x', '/r/y']),
      denied,
    )) as [Uint8Array, { exitCode: number }]
    expect(io.exitCode).toBe(0)
    expect(DEC.decode(out)).toBe('/r\n\n0 directories, 0 files\n')
  })
})

describe('treeGeneric across a nested mount', () => {
  const PARENT: Record<string, FileType> = {
    '/base': FileType.DIRECTORY,
    '/base/top.txt': FileType.FILE,
    '/base/inner': FileType.DIRECTORY,
    '/base/inner/leftover.txt': FileType.FILE,
  }
  const CHILD: Record<string, FileType> = {
    '/base/inner': FileType.DIRECTORY,
    '/base/inner/real.txt': FileType.FILE,
    '/base/inner/deep': FileType.DIRECTORY,
    '/base/inner/deep/d.txt': FileType.FILE,
  }
  const ROOT = '/base/inner'

  // Each path is answered by its OWNING mount: a key the parent holds
  // under the mount root is shadowed and cannot be reached through it,
  // which is the whole point of crossing.
  function owner(virtual: string): Record<string, FileType> {
    return virtual === ROOT || virtual.startsWith(ROOT + '/') ? CHILD : PARENT
  }

  function listing(rows: Record<string, FileType>, dir: string): string[] {
    const prefix = rstripSlash(dir) + '/'
    return Object.keys(rows)
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
      .sort()
  }

  function backendReaddir(p: PathSpec): Promise<string[]> {
    return Promise.resolve(listing(PARENT, key(p)))
  }

  function backendStat(p: PathSpec): Promise<FileStat> {
    const type = PARENT[key(p)]
    if (type === undefined) return Promise.reject(new Error(`ENOENT ${key(p)}`))
    return Promise.resolve(new FileStat({ name: key(p).split('/').pop() ?? '', type }))
  }

  function crossOpts(): Context {
    const dispatch: DispatchFn = (op, path) => {
      const virtual = path.virtual
      if (op === 'readdir') {
        return Promise.resolve([listing(owner(virtual), virtual), new IOResult()])
      }
      const type = owner(virtual)[virtual]
      return Promise.resolve([
        type === undefined ? null : new FileStat({ name: virtual.split('/').pop() ?? '', type }),
        new IOResult(),
      ])
    }
    return {
      ...ctx({}),
      vfs: new Files(dispatch, readers(['/', `${ROOT}/`]), null, { ledger: false }),
    } as unknown as Context
  }

  // Real tree draws the mounted filesystem's entries under the mount
  // point, never the ones it covers, and counts the whole thing once
  // (pinned on tree 2.2.1 over a tmpfs at the same spot). Concatenating a
  // per-mount run cannot do that: it would print two roots and two
  // summaries.
  it('draws the mounted entries and none of the covered ones', async () => {
    // A run on the parent mount, so the nested mount is a boundary.
    const [out] = (await runWithMountGate('/', MountMode.WRITE, () =>
      treeGeneric([spec('/base')], crossOpts(), backendReaddir, backendStat),
    )) as [Uint8Array, unknown]
    expect(DEC.decode(out)).toBe(
      [
        '/base',
        '|-- inner',
        '|   |-- deep',
        '|   |   `-- d.txt',
        '|   `-- real.txt',
        '`-- top.txt',
        '',
        '3 directories, 3 files',
        '',
      ].join('\n'),
    )
  })

  it.each([
    ['its own row', true],
    ['the mount table alone', false],
  ])('prints a mount root from %s', async (_name, known) => {
    const dispatch: DispatchFn = (op, path) =>
      Promise.resolve([
        op === 'readdir'
          ? listing(owner(path.virtual), path.virtual)
          : known
            ? new FileStat({ name: '', type: FileType.DIRECTORY, mode: 0o40700 })
            : null,
        new IOResult(),
      ])
    const withRow = {
      ...ctx({ p: true, noreport: true }),
      vfs: new Files(dispatch, readers(['/', `${ROOT}/`]), null, { ledger: false }),
    } as unknown as Context
    const [out] = (await runWithMountGate('/', MountMode.WRITE, () =>
      treeGeneric([spec('/base')], withRow, backendReaddir, backendStat),
    )) as [Uint8Array, unknown]
    const row =
      DEC.decode(out)
        .split('\n')
        .find((line) => line.endsWith('inner')) ?? ''
    expect(row.includes('drwx------')).toBe(known)
  })

  it('stops at the mount point under -L 1', async () => {
    const withDepth = { ...crossOpts(), flags: { L: '1' } } as unknown as Context
    const [out] = (await runWithMountGate('/', MountMode.WRITE, () =>
      treeGeneric([spec('/base')], withDepth, backendReaddir, backendStat),
    )) as [Uint8Array, unknown]
    expect(DEC.decode(out)).toBe(
      ['/base', '|-- inner', '`-- top.txt', '', '2 directories, 1 file', ''].join('\n'),
    )
  })
})

// tree reads -L as strtoul at base 0 cast to an int, and refuses a level under
// 1 whatever was typed, exit 1. Mirrors test_tree.py.
describe('tree -L', () => {
  it.each([
    ['2', 2],
    ['0x10', 16],
    ['010', 8],
  ])('reads %j as %s', (raw, level) => {
    const parsed = parseFlags({ L: raw })
    if (parsed instanceof IOResult) throw new Error('tree refused a level')
    expect(parsed.maxDepth).toBe(level)
  })

  it.each(['0', '-1', 'x', ''])('refuses %j', (raw) => {
    const parsed = parseFlags({ L: raw })
    if (!(parsed instanceof IOResult)) throw new Error('tree read a refused level')
    expect([parsed.exitCode, DEC.decode(parsed.stderr as Uint8Array)]).toEqual([
      1,
      'tree: Invalid level, must be greater than 0.\n',
    ])
  })
})

describe('tree sizes, orders and JSON', () => {
  const sized: Record<string, FileStat> = {
    '/r': new FileStat({ name: 'r', type: FileType.DIRECTORY }),
    '/r/a.txt': new FileStat({ name: 'a.txt', size: 6, type: FileType.FILE }),
    '/r/b': new FileStat({ name: 'b', type: FileType.DIRECTORY }),
    '/r/b/z10': new FileStat({ name: 'z10', size: 6, type: FileType.FILE }),
    '/r/b/z9': new FileStat({ name: 'z9', size: 1, type: FileType.FILE }),
    '/r/empty': new FileStat({ name: 'empty', type: FileType.DIRECTORY }),
    '/r/.gitignore': new FileStat({ name: '.gitignore', size: 6, type: FileType.FILE }),
    '/r/x.log': new FileStat({ name: 'x.log', size: 3, type: FileType.FILE }),
  }
  const sizedStat = (p: PathSpec): Promise<FileStat> => {
    const row = sized[key(p)]
    return row === undefined ? Promise.reject(new Error(key(p))) : Promise.resolve(row)
  }
  const sizedReaddir = (p: PathSpec): Promise<string[]> => {
    const prefix = `${key(p)}/`
    return Promise.resolve(
      Object.keys(sized).filter(
        (path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
      ),
    )
  }
  async function* readGitignore(p: PathSpec): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    expect(p.virtual).toBe('/r/.gitignore')
    yield new TextEncoder().encode('*.log\n')
  }
  function lineFlags(argv: string[]): TreeFlags | IOResult {
    return parseFlags(parseLineFlags(argv, specOf('tree'), 'tree', '/').flagKwargs)
  }

  it.each([
    [
      ['--du', '-s'],
      '[      12304]  /r\n|-- [          6]  a.txt\n|-- [       4103]  b\n|   |-- [          6]  z10\n' +
        '|   `-- [          1]  z9\n|-- [       4096]  empty\n`-- [          3]  x.log\n\n' +
        '       12304 bytes used in 3 directories, 4 files\n',
    ],
    [
      ['--gitignore', '--prune', '--dirsfirst', '--sort=size'],
      '/r\n|-- b\n|   |-- z10\n|   `-- z9\n`-- a.txt\n\n2 directories, 3 files\n',
    ],
    [
      ['-J', '-f', '--filelimit', '1'],
      '[\n  {"type":"directory","name":"/r","contents":[{"error": ' +
        '"4 entries exceeds filelimit, not opening dir"}\n  ]}\n,\n' +
        '  {"type":"report","directories":1,"files":0}\n]\n',
    ],
    [
      ['-J', '-i', '--noreport', '-L', '1'],
      '[{"type":"directory","name":"/r","contents":[{"type":"file","name":"a.txt"},' +
        '{"type":"directory","name":"b"},{"type":"directory","name":"empty"},' +
        '{"type":"file","name":"x.log"}]}]\n',
    ],
  ])('draws %j', async (argv, expected) => {
    const flags = lineFlags(argv) as TreeFlags
    const root = new PathSpec({
      virtual: '/r',
      directory: '/r',
      resolved: false,
      vfsPath: 'r',
      rawPath: '/r',
    })
    const [out, io] = (await generic(
      flags,
      [root],
      ctx({}),
      sizedReaddir,
      sizedStat,
      undefined,
      readGitignore,
    )) as [Uint8Array, IOResult]
    expect([DEC.decode(out), io.exitCode]).toEqual([expected, 0])
  })

  it('draws a tree too long for one call', { timeout: 60_000 }, async () => {
    const names = Array.from({ length: 200_000 }, (_, i) => `/r/f${String(i)}`)
    const flags = lineFlags(['--noreport']) as TreeFlags
    const [out] = (await generic(
      flags,
      [
        new PathSpec({
          virtual: '/r',
          directory: '/r',
          resolved: false,
          vfsPath: 'r',
          rawPath: '/r',
        }),
      ],
      ctx({}),
      (p: PathSpec) => Promise.resolve(p.virtual === '/r' ? names : []),
      (p: PathSpec) =>
        Promise.resolve(
          new FileStat({
            name: p.virtual.split('/').pop() ?? '',
            type: p.virtual === '/r' ? FileType.DIRECTORY : FileType.FILE,
          }),
        ),
    )) as [Uint8Array, IOResult]
    expect(DEC.decode(out).split('\n').length).toBe(200_002)
  })

  it('sorts by status change where a backend keeps one', async () => {
    const rootStat = new FileStat({ name: 'r', type: FileType.DIRECTORY })
    const times = new Map([
      ['/r', rootStat],
      [
        '/r/a',
        new FileStat({
          name: 'a',
          type: FileType.FILE,
          modified: '2001-01-01T00:00:00Z',
          ctime: '2003-01-01T00:00:00Z',
        }),
      ],
      ['/r/b', new FileStat({ name: 'b', type: FileType.FILE, modified: '2002-01-01T00:00:00Z' })],
    ])
    const root = new PathSpec({
      virtual: '/r',
      directory: '/r',
      resolved: false,
      vfsPath: 'r',
      rawPath: '/r',
    })
    const last = async (sort: string): Promise<string | undefined> => {
      const flags = lineFlags([`--sort=${sort}`, '--noreport']) as TreeFlags
      const [out] = (await generic(
        flags,
        [root],
        ctx({}),
        (p: PathSpec) => Promise.resolve(p.virtual === '/r' ? ['/r/a', '/r/b'] : []),
        (p: PathSpec) => Promise.resolve(times.get(p.virtual) ?? rootStat),
      )) as [Uint8Array, IOResult]
      return DEC.decode(out).trim().split(/\s+/).pop()
    }
    expect([await last('mtime'), await last('ctime')]).toEqual(['b', 'a'])
  })

  it.each([
    ['a/b', 'a/b', true],
    ['a/b', 'a/c', false],
    ['a', 'a/**', false],
    ['a/b/c', 'a/**', true],
    ['a/b/c', '**/c', true],
    ['c', '**/c', true],
    ['a/x/b/y/c', 'a/**/b/**/c', true],
    ['a/b', 'a/**/b/**/c', false],
    ['b/a', 'a/**/b', false],
    ['a/b/x', '**/b', false],
    ['a/b', '**', true],
  ])('fits %j to the ignore pattern %j: %j', (path, pattern, hit) => {
    expect(segmentsMatch(path.split('/'), pattern.split('/'))).toBe(hit)
  })

  it('ends over many globstars and a deep path', () => {
    const parts = Array.from({ length: 200 }, () => 'a')
    expect(segmentsMatch(parts, [...Array.from({ length: 200 }, () => '**'), 'absent'])).toBe(false)
  })

  it.each([
    [[], 'name', null],
    [['-t', '--sort=size'], 'size', null],
    [['--sort=size', '-U'], 'none', null],
    [['-v', '--filelimit', '3'], 'version', 3],
    [['--filelimit=0'], 'name', null],
  ])('reads %j as the last order typed', (argv, sort, limit) => {
    const flags = lineFlags(argv) as TreeFlags
    expect([flags.sort, flags.fileLimit]).toEqual([sort, limit])
  })

  it('names the orders when one is unknown', () => {
    const io = lineFlags(['--sort=n']) as IOResult
    expect([
      io.exitCode,
      DEC.decode(io.stdout as Uint8Array),
      DEC.decode(io.stderr as Uint8Array),
    ]).toEqual([
      1,
      'name,version,size,mtime,ctime,none\n',
      "tree: Sort type 'n' not valid, should be one of: ",
    ])
  })
})
