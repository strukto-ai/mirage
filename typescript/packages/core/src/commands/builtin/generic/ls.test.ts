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
import { describe, expect, it, vi } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { MountView } from '../../../view/types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { CommandOpts } from '../../config.ts'
import {
  LS_FAILURE,
  LS_MINOR_PROBLEM,
  LS_OK,
  exitStatusFor,
  filevercmp,
  lsGeneric,
  parseFlags,
  typeIndicator,
} from './ls.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'

const DEC = new TextDecoder()

const MODIFIED: Record<string, string> = {
  'apple.txt': '2026-01-03T00:00:00Z',
  'Banana.txt': '2026-01-01T00:00:00Z',
  'CHERRY.txt': '2026-01-02T00:00:00Z',
}

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

function opts(flags: Record<string, string | boolean | number | string[]>): CommandOpts {
  return {
    stdin: null,
    flags,
    cwd: '/',
    vfs: null,
  } as unknown as CommandOpts
}

const stat = (p: PathSpec): Promise<FileStat> => {
  const name = key(p).split('/').pop() ?? ''
  return Promise.resolve(
    new FileStat({
      name,
      type: key(p) === '/' ? FileType.DIRECTORY : FileType.FILE,
      modified: MODIFIED[name] ?? null,
    }),
  )
}

const readdir = (p: PathSpec): Promise<string[]> => {
  if (key(p) === '/') return Promise.resolve(['/apple.txt', '/Banana.txt', '/CHERRY.txt'])
  return Promise.resolve([])
}

describe('lsGeneric', () => {
  // On a mount that keeps no listing index each entry's stat is a
  // backend request; a whole directory's worth at once is a burst.
  it('stats one entry at a time', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `/${String(i)}.json`)
    let inFlight = 0
    let peak = 0
    const slowStat = async (p: PathSpec): Promise<FileStat> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return new FileStat({ name: key(p).split('/').pop() ?? '', type: FileType.FILE })
    }
    const result = await lsGeneric([spec('/')], opts({}), () => Promise.resolve(names), slowStat)
    expect(DEC.decode((result?.[0] ?? new Uint8Array()) as Uint8Array).split('\n')).toHaveLength(41)
    expect(peak).toBe(1)
  })
})

// GNU coreutils 9.7 exit codes: 0 ok, 1 minor problem (trouble met below an
// operand), 2 serious trouble (a command-line operand could not be accessed).
// Pinned with `docker run --rm debian:stable-slim`.
const enoent = (): Promise<never> =>
  Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }))

const eacces = (): Promise<never> =>
  Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))

// `/good` lists two entries; `/bad` does not exist; `/half` lists one entry
// whose stat is denied.
const codeReaddir = (p: PathSpec): Promise<string[]> => {
  const k = key(p)
  if (k === '/good') return Promise.resolve(['/good/a.txt', '/good/b.txt'])
  if (k === '/half') return Promise.resolve(['/half/locked.txt'])
  if (k === '/deep') return Promise.resolve(['/deep/sub'])
  if (k === '/deep/sub') return eacces()
  return enoent()
}

const codeStat = (p: PathSpec): Promise<FileStat> => {
  const k = key(p)
  if (k === '/half/locked.txt') return eacces()
  if (k === '/bad' || k.startsWith('/bad/')) return enoent()
  const dir = k === '/good' || k === '/half' || k === '/deep' || k === '/deep/sub'
  return Promise.resolve(
    new FileStat({
      name: k.split('/').pop() ?? '',
      type: dir ? FileType.DIRECTORY : FileType.FILE,
    }),
  )
}

async function status(
  paths: string[],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<[number, string]> {
  const result = await lsGeneric(paths.map(spec), opts(flags), codeReaddir, codeStat)
  if (result === null) return [-1, '']
  const [out, io] = result
  return [io.exitCode, DEC.decode((out ?? new Uint8Array()) as Uint8Array)]
}

describe('lsGeneric exit codes', () => {
  it('exits 1 when an entry below the operand cannot be stat', async () => {
    const [code, out] = await status(['/half'], { args_l: true })
    expect(code).toBe(LS_MINOR_PROBLEM)
    // Not fatal, and not dropped: the entry keeps GNU's row of `?`.
    expect(out).toContain('? locked.txt')
  })

  it('lets a serious problem outrank a minor one', async () => {
    expect((await status(['/half', '/bad']))[0]).toBe(LS_FAILURE)
  })

  it('ratchets the status like GNU set_exit_status', () => {
    const minor = { message: "ls: cannot access 'x': Permission denied", serious: false }
    const serious = { message: "ls: cannot access '/nope': No such file", serious: true }
    expect(exitStatusFor([])).toBe(LS_OK)
    expect(exitStatusFor([minor])).toBe(LS_MINOR_PROBLEM)
    expect(exitStatusFor([serious])).toBe(LS_FAILURE)
    expect(exitStatusFor([minor, serious])).toBe(LS_FAILURE)
    expect(exitStatusFor([serious, minor])).toBe(LS_FAILURE)
  })
})

describe('structure-only directories', () => {
  const missing = (p: PathSpec): Promise<never> => {
    const err = new Error(p.virtual) as Error & { code: string }
    err.code = 'ENOENT'
    return Promise.reject(err)
  }
  // Only `isRoot` is exercised: it is what tells a nested mount's root
  // (whose listing belongs to another backend) from a directory the
  // namespace merely owes children, which -R must still descend.
  const mountsAt = (...roots: string[]): MountView => ({
    descendants: (p) => roots.filter((r) => r.startsWith(`${rstripSlash(p)}/`)),
    visibleDescendants: (p) => roots.filter((r) => r.startsWith(`${rstripSlash(p)}/`)),
    isRoot: (p) => roots.includes(rstripSlash(p)),
    rootOf: () => '/',
  })

  // A structure chain (a link's ancestors) continues below the first
  // level, so -R descends it: only a mount root stops the walk.
  it('-R descends structure that continues below', async () => {
    const chain = (parent: string): string[] =>
      parent === '/ghost' ? ['deep'] : parent === '/ghost/deep' ? ['lnk'] : []
    const result = await lsGeneric(
      [PathSpec.fromStrPath('/ghost')],
      {
        flags: { recursive: true },
        cwd: '/',
        ns: { childMounts: chain, mounts: mountsAt('/ghost/deep/lnk') },
      } as never,
      missing,
      missing,
    )
    expect(result?.[1].exitCode).toBe(LS_OK)
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/ghost:\ndeep\n\n/ghost/deep:\nlnk\n')
  })

  // Absence of the dispatcher can only mean "nobody can answer", so the row keeps
  // the shape every caller outside a workspace already saw.
  it('falls back to a directory row with no dispatcher', async () => {
    const result = await lsGeneric(
      [PathSpec.fromStrPath('/ghost')],
      {
        flags: { classify: true },
        cwd: '/',
        ns: { childMounts: (parent: string) => (parent === '/ghost' ? ['deep'] : []) },
      } as never,
      missing,
      missing,
    )
    expect(result?.[1].exitCode).toBe(LS_OK)
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('deep/\n')
  })
})

describe('honest per-entry errors', () => {
  function stamped(p: string, code: string): Error {
    const e = new Error(p) as Error & { code: string }
    e.code = code
    return e
  }

  function statFailingEntries(err: Error) {
    return (p: PathSpec): Promise<FileStat> =>
      key(p) === '/apple.txt' ? Promise.reject(err) : stat(p)
  }

  async function run(flags: Record<string, boolean>, err: Error) {
    const result = await lsGeneric([spec('/')], opts(flags), readdir, statFailingEntries(err))
    return {
      code: result?.[1].exitCode,
      stdout: DEC.decode(result?.[0] as Uint8Array),
      stderr: DEC.decode((result?.[1].stderr ?? new Uint8Array()) as Uint8Array),
    }
  }

  // GNU (coreutils 9.7, EIO injected on one entry with strace) lists every
  // name, and only a listing that stats the entry (-l, -F, -t, -i ...)
  // reports it, whatever the errno, and exits 1.
  it.each([
    [stamped('/apple.txt', 'ENOENT'), {}, 'apple.txt', ''],
    [new Error('socket hang up'), {}, 'apple.txt', ''],
    [
      stamped('/apple.txt', 'ENOENT'),
      { args_l: true },
      '?????????? ? ? ? ?            ? apple.txt',
      "ls: cannot access '/apple.txt': No such file or directory\n",
    ],
    [
      new Error('S3 GET apple.txt failed: 403 Forbidden'),
      { classify: true },
      'apple.txt',
      "ls: cannot access '/apple.txt': S3 GET apple.txt failed: 403 Forbidden\n",
    ],
    [
      stamped('/apple.txt', 'EIO'),
      { args_l: true },
      '?????????? ? ? ? ?            ? apple.txt',
      "ls: cannot access '/apple.txt': Input/output error\n",
    ],
  ])('lists an entry whose stat failed with %s under %o', async (err, flags, row, expected) => {
    const host = (['debug', 'log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    )
    try {
      const { code, stdout, stderr } = await run(flags, err)
      expect(stdout.trimEnd().split('\n').slice(-2)).toEqual([
        expect.stringMatching(/CHERRY\.txt$/),
        row,
      ])
      expect(stderr).toBe(expected)
      expect(code).toBe(expected === '' ? LS_OK : LS_MINOR_PROBLEM)
      for (const spy of host) expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })

  // GNU (coreutils 9.7, both entries' stat denied) zeroes a failed stat, so
  // -S sorts the rows as size 0 even where readdir marked a directory.
  it('-S counts an unstattable directory as size 0', async () => {
    const marking = (p: PathSpec): Promise<string[]> =>
      Promise.resolve(key(p) === '/' ? ['/afile', '/zdir/'] : [])
    const denying = (p: PathSpec): Promise<FileStat> =>
      key(p) === '/' ? stat(p) : Promise.reject(stamped(key(p), 'EACCES'))
    const result = await lsGeneric([spec('/')], opts({ S: true }), marking, denying)
    expect(result?.[1].exitCode).toBe(LS_MINOR_PROBLEM)
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('afile\nzdir\n')
  })

  it('still ends the command on a timeout or an abort', async () => {
    await expect(run({}, new CommandTimeoutError('stat', 5))).rejects.toThrow('timed out')
    await expect(run({}, new DOMException('execute aborted', 'AbortError'))).rejects.toThrow(
      'execute aborted',
    )
  })

  it("still propagates the operand's own unstamped failure", async () => {
    const failing = (): Promise<string[]> => Promise.reject(new Error('socket hang up'))
    await expect(lsGeneric([spec('/')], opts({}), failing, stat)).rejects.toThrow('socket hang up')
  })

  it('-d propagates an unstamped stat error', async () => {
    const raw = new Error('rate limited')
    const failing = (): Promise<FileStat> => Promise.reject(raw)
    await expect(
      lsGeneric([spec('/x')], opts({ directory: true }), readdir, failing),
    ).rejects.toThrow('rate limited')
  })
})

describe('lsGeneric sort orders', () => {
  it('filevercmp pins gnulib corner cases', () => {
    expect(filevercmp('file2.txt', 'file10.txt')).toBeLessThan(0)
    expect(filevercmp('a.txt', 'a.tar.gz')).toBeGreaterThan(0)
    expect(filevercmp('', 'a')).toBeLessThan(0)
    expect(filevercmp('.', '..')).toBeLessThan(0)
    expect(filevercmp('.hidden', 'a')).toBeLessThan(0)
    expect(filevercmp('1.0~rc1', '1.0')).toBeLessThan(0)
    expect(filevercmp('abc', 'abc')).toBe(0)
  })

  it('filevercmp orders bytes past the letters', () => {
    // Pinned on coreutils 9.7 under LC_ALL=C: `_ { é ÿ Ā €` and
    // `a- a{ aé`, since gnulib classifies bytes, not code points.
    expect(filevercmp('_', '{')).toBeLessThan(0)
    expect(filevercmp('{', 'é')).toBeLessThan(0)
    expect(filevercmp('é', 'ÿ')).toBeLessThan(0)
    expect(filevercmp('ÿ', 'Ā')).toBeLessThan(0)
    expect(filevercmp('Ā', '€')).toBeLessThan(0)
    expect(filevercmp('a-', 'a{')).toBeLessThan(0)
    expect(filevercmp('a{', 'aé')).toBeLessThan(0)
    expect(filevercmp('\uffff', '\u{1d11e}')).toBeLessThan(0)
  })
})

describe('lsGeneric parseFlags', () => {
  it.each([
    [{ t: true, S: true }, 'size', 'mtime'],
    [{ S: true, sort: 'version' }, 'version', 'mtime'],
    [{ u: true }, 'time', 'atime'],
    [{ u: true, args_l: true }, 'name', 'atime'],
    [{ c: true, u: true, time: 'status' }, 'time', 'ctime'],
    [{ X: true, U: true }, 'none', 'mtime'],
  ])('parseFlags: the last sort and time spelling win (%o)', (flags, sortBy, timeKind) => {
    const parsed = parseFlags(new FlagView(flags as Record<string, FlagValue>, specOf('ls')))
    expect(parsed.sortBy).toBe(sortBy)
    expect(parsed.timeKind).toBe(timeKind)
  })

  // gnulib's argmatch resolves an unambiguous prefix and answers the
  // canonical word of the value it matched. Every row measured on coreutils
  // 9.7 (`ls --sort=non`, `-l --time=acc`, `--hyperlink=n`,
  // `-l --time-style=full`). Mirrors test_ls.py. A posix- prefix
  // short-circuits the option before the matcher: GNU jumps to the locale
  // style without reading what follows, `posix-l` included, which is
  // ambiguous only if the remainder is matched (it must not be).
  it.each<[Record<string, string>, string, string | boolean]>([
    [{ sort: 'non' }, 'sortBy', 'none'],
    [{ sort: 'si' }, 'sortBy', 'size'],
    [{ time: 'a' }, 'timeKind', 'atime'],
    [{ time: 'acc' }, 'timeKind', 'atime'],
    [{ time: 'u' }, 'timeKind', 'atime'],
    [{ time: 'm' }, 'timeKind', 'mtime'],
    [{ time: 's' }, 'timeKind', 'ctime'],
    [{ time: 'b' }, 'timeKind', 'birth'],
    [{ hyperlink: 'al' }, 'hyperlink', true],
    [{ hyperlink: 'y' }, 'hyperlink', true],
    [{ hyperlink: 'f' }, 'hyperlink', true],
    [{ hyperlink: 'n' }, 'hyperlink', false],
    [{ hyperlink: 'au' }, 'hyperlink', false],
    [{ hyperlink: 'i' }, 'hyperlink', false],
    [{ time_style: 'full' }, 'columns.timeStyle', 'full-iso'],
    [{ time_style: 'long' }, 'columns.timeStyle', 'long-iso'],
    [{ time_style: 'i' }, 'columns.timeStyle', 'iso'],
    [{ time_style: 'loc' }, 'columns.timeStyle', 'locale'],
    ...[
      'posix-full-iso',
      'posix-long-iso',
      'posix-iso',
      'posix-locale',
      'posix-l',
      'posix-zzz',
      'posix-',
      'posix-+%H:%M',
      'posix-posix-full-iso',
    ].map((value): [Record<string, string>, string, string] => [
      { time_style: value },
      'columns.timeStyle',
      'locale',
    ]),
  ])('parseFlags reads %o into %s as %s', (flags, attr, expected) => {
    const parsed = parseFlags(new FlagView(flags, specOf('ls')))
    const value = attr
      .split('.')
      .reduce<unknown>((at, name) => (at as Record<string, unknown>)[name], parsed)
    expect(value).toBe(expected)
  })
})

describe('dot entries respect mount boundaries', () => {
  for (const prefix of ['', '/data', '/nested/data']) {
    for (const subdir of [false, true]) {
      it.each([false, true])(
        `prefix=${prefix} subdir=${String(subdir)} namespace=%s`,
        async (namespace) => {
          const root = prefix || '/'
          const directory = subdir ? `${prefix}/sub` : root
          const tree = new Map([
            [root, new FileStat({ name: 'root', type: FileType.DIRECTORY, mode: 0o751 })],
            [`${prefix}/sub`, new FileStat({ name: 'sub', type: FileType.DIRECTORY, mode: 0o750 })],
          ])
          const backendStat = vi.fn((path: PathSpec): Promise<FileStat> => {
            const row = tree.get(path.virtual)
            if (row === undefined) throw new Error(`out-of-mount stat: ${path.virtual}`)
            expect(path.vfsPath).toBe(mountKey(path.virtual, prefix))
            return Promise.resolve(row)
          })
          const read = (path: PathSpec): Promise<string[]> =>
            Promise.resolve(path.virtual === root ? [`${prefix}/sub`] : [])
          const statPath = vi.fn((path: string | PathSpec): Promise<FileStat> =>
            Promise.resolve(
              tree.get(typeof path === 'string' ? path : path.virtual) ??
                new FileStat({
                  name: 'parent',
                  type: FileType.DIRECTORY,
                  mode: 0o700,
                }),
            ),
          )
          const options = opts({ all: true, args_l: true })
          if (namespace) options.statPath = statPath
          const result = await lsGeneric(
            [new PathSpec({ virtual: directory, directory, vfsPath: subdir ? 'sub' : '' })],
            options,
            read,
            backendStat,
          )
          expect(result?.[1].exitCode).toBe(0)
          expect(result?.[1].stderr).toBeNull()
          const output = DEC.decode(result?.[0] as Uint8Array)
          const dotMode = subdir ? 'drwxr-x---' : 'drwxr-x--x'
          const parentMode =
            subdir || !prefix ? 'drwxr-x--x' : namespace ? 'drwx------' : 'drwxr-xr-x'
          expect(output).toContain(`${dotMode} 1 - - 4096 - .\n`)
          expect(output).toContain(`${parentMode} 1 - - 4096 - ..\n`)
          if (namespace) {
            const parent = subdir ? root : root.slice(0, root.lastIndexOf('/')) || '/'
            expect(statPath.mock.calls.slice(-2)).toEqual([[directory], [parent]])
          } else {
            expect(backendStat).toHaveBeenCalled()
          }
        },
      )
    }
  }
})

describe('typeIndicator', () => {
  // ls.c get_type_indicator: slash marks only directories, and only classify
  // marks an executable. Mirrors test_ls.py.
  it.each([
    [FileType.DIRECTORY, null, ['', '/', '/', '/']],
    [FileType.SYMLINK, null, ['', '', '@', '@']],
    [FileType.FIFO, null, ['', '', '|', '|']],
    [FileType.FILE, 0o755, ['', '', '', '*']],
    [FileType.FILE, 0o644, ['', '', '', '']],
  ] as const)('marks %s (mode %s) by style', (type, mode, marks) => {
    const entry = new FileStat({ name: 'x', type, mode })
    const styles = ['none', 'slash', 'file-type', 'classify'] as const
    expect(styles.map((s) => typeIndicator(entry, s))).toEqual(marks)
  })

  it('marks nothing it could not stat', () => {
    expect(typeIndicator(null, 'classify')).toBe('')
  })
})
