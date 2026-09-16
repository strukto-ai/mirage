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
import { ContentType, FileStat, FileType, LINK_TARGET_KEY, PathSpec } from '../../../types.ts'
import type { LinkView, MountView } from '../../../ops/types.ts'
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
  sortStats,
} from './ls.ts'
import { UsageError } from '../../errors.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView, type FlagValue } from '../../spec/types.ts'

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
    resourcePath: mountKey(path, ''),
  })
}

function opts(flags: Record<string, string | boolean | number | string[]>): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null,
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

async function run(flags: Record<string, string | boolean | number | string[]>): Promise<string[]> {
  const result = await lsGeneric([spec('/')], opts(flags), readdir, stat)
  if (result === null) return []
  const [out] = result
  return DEC.decode(out as Uint8Array)
    .replace(/\n$/, '')
    .split('\n')
}

describe('lsGeneric', () => {
  it('sorts names by ASCII byte order, uppercase before lowercase', async () => {
    expect(await run({})).toEqual(['Banana.txt', 'CHERRY.txt', 'apple.txt'])
  })

  it('-r reverses the ASCII order', async () => {
    expect(await run({ reverse: true })).toEqual(['apple.txt', 'CHERRY.txt', 'Banana.txt'])
  })

  it('-t sorts newest first by codepoint comparison of modified', async () => {
    expect(await run({ t: true })).toEqual(['apple.txt', 'CHERRY.txt', 'Banana.txt'])
  })

  it('-tr sorts oldest first', async () => {
    expect(await run({ t: true, reverse: true })).toEqual(['Banana.txt', 'CHERRY.txt', 'apple.txt'])
  })
})

// Mirrors the Python generic ls operand tests: GNU prints file operands first
// with no header, then names every directory once more than one operand (or -R)
// is in play, blank-line separated.
const TREE: Record<string, FileType> = {
  '/a': FileType.DIRECTORY,
  '/a/f.txt': FileType.FILE,
  '/a/sub': FileType.DIRECTORY,
  '/b': FileType.DIRECTORY,
  '/b/g.txt': FileType.FILE,
  '/c': FileType.DIRECTORY,
  '/mfile': FileType.FILE,
  '/zfile': FileType.FILE,
}

const treeStat = (p: PathSpec): Promise<FileStat> => {
  const path = key(p)
  const type = TREE[path]
  if (type === undefined) return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
  return Promise.resolve(
    new FileStat({ name: path.split('/').pop() ?? '', type, size: type === FileType.FILE ? 3 : 0 }),
  )
}

const treeReaddir = (p: PathSpec): Promise<string[]> => {
  const path = key(p)
  const type = TREE[path]
  if (type === undefined) return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
  if (type !== FileType.DIRECTORY) {
    return Promise.reject(Object.assign(new Error(path), { code: 'ENOTDIR' }))
  }
  const prefix = path === '/' ? '/' : `${path}/`
  return Promise.resolve(
    Object.keys(TREE).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')),
  )
}

async function runTree(
  paths: string[],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await lsGeneric(paths.map(spec), opts(flags), treeReaddir, treeStat)
  if (result === null) return { stdout: '', stderr: '', exitCode: 0 }
  const [out, io] = result
  return {
    stdout: DEC.decode(out as Uint8Array),
    stderr: io.stderr === null ? '' : DEC.decode(io.stderr as Uint8Array),
    exitCode: io.exitCode,
  }
}

describe('lsGeneric operand headers', () => {
  it('a single directory operand has no header', async () => {
    expect((await runTree(['/a'])).stdout).toBe('f.txt\nsub\n')
  })

  it('two directory operands are headed and blank-line separated', async () => {
    const r = await runTree(['/a', '/b'])
    expect(r.stdout).toBe('/a:\nf.txt\nsub\n\n/b:\ng.txt\n')
    expect(r.exitCode).toBe(0)
  })

  it('an empty directory operand still gets a header', async () => {
    expect((await runTree(['/b', '/c'])).stdout).toBe('/b:\ng.txt\n\n/c:\n')
  })

  it('file operands print first, unheaded, then the directories', async () => {
    expect((await runTree(['/b', '/zfile', '/a', '/mfile'])).stdout).toBe(
      '/mfile\n/zfile\n\n/a:\nf.txt\nsub\n\n/b:\ng.txt\n',
    )
  })

  it('file operands alone emit no trailing blank line', async () => {
    expect((await runTree(['/zfile', '/mfile'])).stdout).toBe('/mfile\n/zfile\n')
  })

  it('operands sort by name, not command-line order', async () => {
    expect((await runTree(['/b', '/a'])).stdout).toBe('/a:\nf.txt\nsub\n\n/b:\ng.txt\n')
  })

  it('-r flips both the operand order and the entry order', async () => {
    expect((await runTree(['/a', '/b'], { reverse: true })).stdout).toBe(
      '/b:\ng.txt\n\n/a:\nsub\nf.txt\n',
    )
  })

  it('a failed operand still leaves the listed one headed', async () => {
    const r = await runTree(['/nope', '/a'])
    expect(r.stdout).toBe('/a:\nf.txt\nsub\n')
    // The header is output, not evidence of success: the bad operand still
    // ratchets the status to 2.
    expect(r.exitCode).toBe(LS_FAILURE)
    expect(r.stderr).toContain('/nope')
  })

  it('a repeated operand lists twice', async () => {
    expect((await runTree(['/a', '/a'])).stdout).toBe('/a:\nf.txt\nsub\n\n/a:\nf.txt\nsub\n')
  })

  it('-R keeps the header on a lone operand', async () => {
    expect((await runTree(['/a'], { recursive: true })).stdout).toBe('/a:\nf.txt\nsub\n\n/a/sub:\n')
  })

  it('-R does not head a file operand', async () => {
    expect((await runTree(['/a', '/zfile'], { recursive: true })).stdout).toBe(
      '/zfile\n\n/a:\nf.txt\nsub\n\n/a/sub:\n',
    )
  })

  it('-d sorts its operands and stays unheaded', async () => {
    expect((await runTree(['/zfile', '/b', '/a'], { directory: true })).stdout).toBe(
      '/a\n/b\n/zfile\n',
    )
  })
})

// GNU's -t/-S comparators fall back to the name when the primary key ties, and
// -r negates the whole comparison, tie-break included. Pinned with
// `docker run --rm debian:stable-slim` (coreutils 9.7).
const TIED = ['/a', '/b', '/c']

const tiedStat = (p: PathSpec): Promise<FileStat> => {
  const path = key(p)
  if (!TIED.includes(path)) {
    return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
  }
  return Promise.resolve(
    new FileStat({
      name: path.slice(1),
      type: FileType.FILE,
      content: ContentType.TEXT,
      size: 2,
      modified: '2024-01-01T00:00:00Z',
    }),
  )
}

const tiedReaddir = (p: PathSpec): Promise<string[]> =>
  key(p) === '/'
    ? Promise.resolve(TIED)
    : Promise.reject(Object.assign(new Error(), { code: 'ENOTDIR' }))

async function runTied(
  paths: string[],
  flags: Record<string, string | boolean | number | string[]>,
): Promise<string> {
  const result = await lsGeneric(paths.map(spec), opts(flags), tiedReaddir, tiedStat)
  if (result === null) return ''
  return DEC.decode(result[0] as Uint8Array)
}

describe('lsGeneric tie-breaks', () => {
  for (const sort of ['t', 'S']) {
    it(`-${sort} breaks tied operands on the name`, async () => {
      expect(await runTied(['/c', '/a', '/b'], { [sort]: true })).toBe('/a\n/b\n/c\n')
    })

    it(`-${sort}r flips the tie-break too`, async () => {
      expect(await runTied(['/c', '/a', '/b'], { [sort]: true, reverse: true })).toBe(
        '/c\n/b\n/a\n',
      )
    })

    it(`-${sort} breaks tied entries on the name`, async () => {
      expect(await runTied(['/'], { [sort]: true })).toBe('a\nb\nc\n')
      expect(await runTied(['/'], { [sort]: true, reverse: true })).toBe('c\nb\na\n')
    })
  }
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
  it('exits 0 when every operand lists cleanly', async () => {
    const [code] = await status(['/good'])
    expect(code).toBe(LS_OK)
  })

  it('exits 2 for a missing command-line operand', async () => {
    const [code] = await status(['/bad'])
    expect(code).toBe(LS_FAILURE)
  })

  it('exits 2 when only one of several operands is missing', async () => {
    expect((await status(['/bad', '/good']))[0]).toBe(LS_FAILURE)
    expect((await status(['/good', '/bad']))[0]).toBe(LS_FAILURE)
  })

  it('still lists the good operand while exiting 2', async () => {
    const [code, out] = await status(['/bad', '/good'])
    expect(code).toBe(LS_FAILURE)
    expect(out).toContain('a.txt')
  })

  it('exits 2 for a missing operand under -d', async () => {
    expect((await status(['/bad'], { directory: true }))[0]).toBe(LS_FAILURE)
    expect((await status(['/good', '/bad'], { directory: true }))[0]).toBe(LS_FAILURE)
  })

  it('exits 1 when an entry below the operand cannot be stat', async () => {
    const [code, out] = await status(['/half'])
    expect(code).toBe(LS_MINOR_PROBLEM)
    // The unreadable entry is skipped, not fatal: the listing still renders.
    expect(out).not.toContain('locked.txt')
  })

  it('exits 1 when -R cannot open a subdirectory, keeping parent output', async () => {
    const [code, out] = await status(['/deep'], { recursive: true })
    expect(code).toBe(LS_MINOR_PROBLEM)
    expect(out).toContain('/deep:')
  })

  it('lets a serious problem outrank a minor one', async () => {
    expect((await status(['/half', '/bad']))[0]).toBe(LS_FAILURE)
  })

  it('prints no header for a -R operand it cannot open', async () => {
    const [code, out] = await status(['/good', '/bad'], { recursive: true })
    expect(code).toBe(LS_FAILURE)
    expect(out).not.toContain('/bad:')
  })

  it('starts flush left when the first -R operand could not be opened', async () => {
    const [code, out] = await status(['/bad', '/good'], { recursive: true })
    expect(code).toBe(LS_FAILURE)
    expect(out).toBe('/good:\na.txt\nb.txt\n')
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

describe('link operands on backends with different readdir shapes', () => {
  const linkRowStat = new FileStat({
    name: 'flink',
    size: 19,
    modified: '2026-01-02T15:30:00Z',
    type: FileType.SYMLINK,
    extra: { [LINK_TARGET_KEY]: '/data/symx/real.txt' },
  })

  const links: LinkView = {
    statAt: (v: string) => (v.endsWith('flink') ? linkRowStat : null),
    children: () => [],
    subtree: () => [],
    resolve: (v: string) => v,
    exists: () => Promise.resolve(true),
    targetStat: () => Promise.resolve(null),
  }

  const missing = (p: PathSpec): Promise<never> => {
    // Stamped like a real backend's ENOENT; bare errors now propagate.
    const err = new Error(p.virtual) as Error & { code: string }
    err.code = 'ENOENT'
    return Promise.reject(err)
  }

  it('reports the link when readdir throws', async () => {
    const [out] = (await lsGeneric(
      [PathSpec.fromStrPath('/data/symx/flink')],
      { flags: { args_l: true }, cwd: '/', ns: { links } } as never,
      missing,
      missing,
    )) as [Uint8Array, unknown]
    expect(new TextDecoder().decode(out)).toContain('flink -> /data/symx/real.txt')
  })

  // Backends without real directories (s3, nextcloud) answer readdir on
  // a link with an empty list, which rendered an empty directory.
  it('reports the link when readdir returns empty', async () => {
    const [out] = (await lsGeneric(
      [PathSpec.fromStrPath('/data/symx/flink')],
      { flags: { args_l: true }, cwd: '/', ns: { links } } as never,
      () => Promise.resolve([]),
      missing,
    )) as [Uint8Array, unknown]
    expect(new TextDecoder().decode(out)).toContain('flink -> /data/symx/real.txt')
  })
})

describe('structure-only directories', () => {
  const missing = (p: PathSpec): Promise<never> => {
    const err = new Error(p.virtual) as Error & { code: string }
    err.code = 'ENOENT'
    return Promise.reject(err)
  }
  const childMounts = (parent: string): string[] => (parent === '/ghost' ? ['deep'] : [])
  // Only `isRoot` is exercised: it is what tells a nested mount's root
  // (whose listing belongs to another backend) from a directory the
  // namespace merely owes children, which -R must still descend.
  const mountsAt = (...roots: string[]): MountView => ({
    descendants: (p) => roots.filter((r) => r.startsWith(`${rstripSlash(p)}/`)),
    visibleDescendants: (p) => roots.filter((r) => r.startsWith(`${rstripSlash(p)}/`)),
    isRoot: (p) => roots.includes(rstripSlash(p)),
    rootOf: () => '/',
  })

  // A directory no backend serves still lists when the namespace owes it
  // children (a nested mount, a link's ancestors): the door already names
  // it in the parent listing, so ls must agree instead of reporting it
  // missing.
  it('lists namespace children when no backend serves the directory', async () => {
    const result = await lsGeneric(
      [PathSpec.fromStrPath('/ghost')],
      { flags: {}, cwd: '/', ns: { childMounts } } as never,
      missing,
      missing,
    )
    expect(result?.[1].exitCode).toBe(LS_OK)
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('deep\n')
  })

  // Under -R the group still renders from the namespace fact; only
  // descent into the mount root is withheld, because that listing is
  // another backend's and the cross-mount fan-out assembles it.
  it('-R renders the namespace-only group and leaves descent to fan-out', async () => {
    const result = await lsGeneric(
      [PathSpec.fromStrPath('/ghost')],
      {
        flags: { recursive: true },
        cwd: '/',
        ns: { childMounts, mounts: mountsAt('/ghost/deep') },
      } as never,
      missing,
      missing,
    )
    expect(result?.[1].exitCode).toBe(LS_OK)
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/ghost:\ndeep\n')
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

  // A mount root is an ordinary entry of a backend-served directory. GNU
  // (coreutils 9.7, tmpfs at `base/nested`) prints `nested` in `base`'s
  // own listing and then its group. The merge used to be withheld
  // whenever the walk was recursive, on the theory that the cross-mount
  // fan-out contributed the whole nested mount; it contributes the group,
  // not the parent's row, so the row went missing wherever the backend
  // held no key of that name. Descent is what the fan-out owns, and the
  // mount table is what says where to stop.
  it('-R lists a mount root without descending it', async () => {
    const served: Record<string, FileType> = {
      '/base': FileType.DIRECTORY,
      '/base/top.txt': FileType.FILE,
    }
    const servedStat = (p: PathSpec): Promise<FileStat> => {
      const type = served[rstripSlash(p.virtual)]
      if (type === undefined) return missing(p)
      return Promise.resolve(
        new FileStat({ name: rstripSlash(p.virtual).split('/').pop() ?? '', type }),
      )
    }
    const servedReaddir = (p: PathSpec): Promise<string[]> =>
      rstripSlash(p.virtual) === '/base' ? Promise.resolve(['/base/top.txt']) : missing(p)
    const result = await lsGeneric(
      [PathSpec.fromStrPath('/base')],
      {
        flags: { recursive: true },
        cwd: '/',
        ns: {
          childMounts: (parent: string) => (parent === '/base' ? ['nested'] : []),
          mounts: mountsAt('/base/nested'),
        },
      } as never,
      servedReaddir,
      servedStat,
    )
    expect(result?.[1].exitCode).toBe(LS_OK)
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/base:\nnested\ntop.txt\n')
  })

  // A mount root is not always a directory. Every workspace mounts
  // `/.bash_history` as a whole mount serving one file, and no backend can
  // stat it: the parent's cannot see into the child mount and the child's
  // own calls its root '/'. Synthesizing the row as a directory suffixed it
  // with '/' under -F, rendered it `drwxr-xr-x` under -l, and offered it to
  // -R as something to descend. GNU (coreutils 9.7, `mount --bind` of one
  // file onto another) lists it as an ordinary file row of its parent.
  it('does not render a child mount serving one file as a directory', async () => {
    const served: Record<string, FileType> = {
      '/base': FileType.DIRECTORY,
      '/base/top.txt': FileType.FILE,
    }
    const servedStat = (p: PathSpec): Promise<FileStat> => {
      const type = served[rstripSlash(p.virtual)]
      if (type === undefined) return missing(p)
      return Promise.resolve(
        new FileStat({ name: rstripSlash(p.virtual).split('/').pop() ?? '', type }),
      )
    }
    const servedReaddir = (p: PathSpec): Promise<string[]> =>
      rstripSlash(p.virtual) === '/base' ? Promise.resolve(['/base/top.txt']) : missing(p)
    const result = await lsGeneric(
      [PathSpec.fromStrPath('/base')],
      {
        flags: { recursive: true, classify: true },
        cwd: '/',
        // The child mount answers its own root with its name for it.
        statPath: (virtual: string) =>
          Promise.resolve(
            virtual === '/base/hist'
              ? new FileStat({ name: '/', type: FileType.FILE, content: ContentType.TEXT })
              : null,
          ),
        ns: {
          childMounts: (parent: string) => (parent === '/base' ? ['hist'] : []),
          mounts: mountsAt('/base/hist'),
        },
      } as never,
      servedReaddir,
      servedStat,
    )
    expect(result?.[1].exitCode).toBe(LS_OK)
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/base:\nhist\ntop.txt\n')
  })

  // Absence of the door can only mean "nobody can answer", so the row keeps
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

  // -d stats the operand itself; the namespace fact is what says the
  // directory exists, so the row must come from it when no backend does.
  it('-d prints the namespace-only directory row', async () => {
    const result = await lsGeneric(
      [PathSpec.fromStrPath('/ghost')],
      { flags: { directory: true }, cwd: '/', ns: { childMounts } } as never,
      missing,
      missing,
    )
    expect(result?.[1].exitCode).toBe(LS_OK)
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/ghost\n')
  })
})

describe('honest per-entry errors', () => {
  function enoent(p: string): Error {
    const e = new Error(p) as Error & { code: string }
    e.code = 'ENOENT'
    return e
  }

  function statFailingEntries(err: Error) {
    return (p: PathSpec): Promise<FileStat> => (key(p) === '/' ? stat(p) : Promise.reject(err))
  }

  it('warns per entry and ratchets the exit code on a stamped fs error', async () => {
    const result = await lsGeneric(
      [spec('/')],
      opts({}),
      readdir,
      statFailingEntries(enoent('/apple.txt')),
    )
    expect(result?.[1].exitCode).toBe(LS_MINOR_PROBLEM)
    const stderr = DEC.decode(result?.[1].stderr as Uint8Array)
    expect(stderr).toContain("ls: cannot access '/apple.txt': No such file or directory")
  })

  it('propagates an unstamped backend error instead of laundering it', async () => {
    // An error with no POSIX code (auth failure, transport prose) must not
    // become a GNU-shaped 'cannot access' line.
    const raw = new Error('S3 GET apple.txt failed: 403 Forbidden')
    await expect(
      lsGeneric([spec('/')], opts({}), readdir, statFailingEntries(raw)),
    ).rejects.toThrow('403 Forbidden')
  })

  it('-d propagates an unstamped stat error', async () => {
    const raw = new Error('rate limited')
    const failing = (): Promise<FileStat> => Promise.reject(raw)
    await expect(
      lsGeneric([spec('/x')], opts({ directory: true }), readdir, failing),
    ).rejects.toThrow('rate limited')
  })
})

// The flag set beyond -l: sort orders, columns, time styles. Mirrors the
// Python generic ls tests; GNU coreutils 9.7 pinned the orders.
const VERSION_NAMES = ['file10.txt', 'file2.txt', 'Z.txt', 'a.txt', 'b.md', 'c', 'dir1', 'dir2']
const VERSION_SIZES: Record<string, number> = {
  'file10.txt': 10,
  'file2.txt': 2,
  'Z.txt': 1,
  'a.txt': 6,
  'b.md': 1,
  c: 0,
}

const versionStat = (p: PathSpec): Promise<FileStat> => {
  const name = key(p).split('/').pop() ?? ''
  const isDir = key(p) === '/v' || name.startsWith('dir')
  return Promise.resolve(
    new FileStat({
      name,
      type: isDir ? FileType.DIRECTORY : FileType.FILE,
      size: isDir ? null : (VERSION_SIZES[name] ?? 0),
      modified: name === 'a.txt' ? '2025-01-15T10:30:00Z' : null,
    }),
  )
}
const versionReaddir = (p: PathSpec): Promise<string[]> =>
  Promise.resolve(key(p) === '/v' ? VERSION_NAMES.map((n) => `/v/${n}`) : [])

async function runV(
  flags: Record<string, string | boolean | number | string[]>,
): Promise<string[]> {
  const result = await lsGeneric([spec('/v')], opts(flags), versionReaddir, versionStat)
  if (result === null) return []
  const [out] = result
  return DEC.decode(out as Uint8Array)
    .replace(/\n$/, '')
    .split('\n')
}

describe('lsGeneric sort orders', () => {
  it('-v reads numbers as numbers', async () => {
    expect(await runV({ v: true })).toEqual([
      'Z.txt',
      'a.txt',
      'b.md',
      'c',
      'dir1',
      'dir2',
      'file2.txt',
      'file10.txt',
    ])
  })

  it('-X groups by suffix then name', async () => {
    expect(await runV({ X: true })).toEqual([
      'c',
      'dir1',
      'dir2',
      'b.md',
      'Z.txt',
      'a.txt',
      'file10.txt',
      'file2.txt',
    ])
  })

  it('--group-directories-first partitions after sorting, -r included', async () => {
    expect(await runV({ group_directories_first: true })).toEqual([
      'dir1',
      'dir2',
      'Z.txt',
      'a.txt',
      'b.md',
      'c',
      'file10.txt',
      'file2.txt',
    ])
    expect(await runV({ group_directories_first: true, reverse: true })).toEqual([
      'dir2',
      'dir1',
      'file2.txt',
      'file10.txt',
      'c',
      'b.md',
      'a.txt',
      'Z.txt',
    ])
  })

  it('-U keeps the listing order and ignores grouping', async () => {
    expect(await runV({ U: true, group_directories_first: true })).toEqual(VERSION_NAMES)
  })

  it('filevercmp pins gnulib corner cases', () => {
    expect(filevercmp('file2.txt', 'file10.txt')).toBeLessThan(0)
    expect(filevercmp('a.txt', 'a.tar.gz')).toBeGreaterThan(0)
    expect(filevercmp('', 'a')).toBeLessThan(0)
    expect(filevercmp('.', '..')).toBeLessThan(0)
    expect(filevercmp('.hidden', 'a')).toBeLessThan(0)
    expect(filevercmp('1.0~rc1', '1.0')).toBeLessThan(0)
    expect(filevercmp('abc', 'abc')).toBe(0)
  })

  it('sortStats: -U keeps the listing order under -r, and width counts columns', () => {
    const rows = ['b', 'd', 'a'].map((name) => new FileStat({ name, type: FileType.FILE }))
    const names = (stats: FileStat[]): string[] => stats.map((s) => s.name)
    expect(names(sortStats(rows, 'none', false))).toEqual(['b', 'd', 'a'])
    expect(names(sortStats(rows, 'none', true))).toEqual(['b', 'd', 'a'])
    // Pinned on coreutils 9.7 under C.UTF-8: a wide character counts two
    // columns and a combining mark none.
    const wide = ['界', 'aa', 'é', 'a', 'e\u0301x'].map(
      (name) => new FileStat({ name, type: FileType.FILE }),
    )
    expect(names(sortStats(wide, 'width', false))).toEqual(['a', 'é', 'aa', 'e\u0301x', '界'])
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

describe('lsGeneric columns and time styles', () => {
  const single = (p: PathSpec): Promise<FileStat> =>
    Promise.resolve(
      key(p) === '/d'
        ? new FileStat({ name: 'd', type: FileType.DIRECTORY })
        : new FileStat({
            name: 'a.txt',
            type: FileType.FILE,
            size: 42,
            modified: '2025-01-15T10:30:00Z',
          }),
    )
  const singleReaddir = (p: PathSpec): Promise<string[]> =>
    Promise.resolve(key(p) === '/d' ? ['/d/a.txt'] : [])
  async function line(
    flags: Record<string, string | boolean | number | string[]>,
  ): Promise<string> {
    const result = await lsGeneric([spec('/d')], opts(flags), singleReaddir, single)
    return result === null ? '' : DEC.decode(result[0] as Uint8Array)
  }

  it('-g -o drop the owner and group, -i and -Z lead with ?', async () => {
    expect(
      await line({ g: true, o: true, inode: true, context: true, time_style: 'long-iso' }),
    ).toBe('? -rw-r--r-- 1 ? 42 2025-01-15 10:30 a.txt\n')
    expect(await line({ inode: true, context: true })).toBe('? ? a.txt\n')
  })

  it.each([
    ['full-iso', '2025-01-15 10:30:00.000000000 +0000'],
    ['long-iso', '2025-01-15 10:30'],
    ['iso', '2025-01-15 '],
    ['+%Y/%m/%d', '2025/01/15'],
    ['+%Y\n%H:%M', '2025'],
  ])('--time-style=%s spells an old time as GNU does', async (style, expected) => {
    expect(await line({ g: true, o: true, time_style: style })).toBe(
      `-rw-r--r-- 1 42 ${expected} a.txt\n`,
    )
  })

  it('--block-size scales and rounds up', async () => {
    expect(await line({ g: true, o: true, block_size: 'K', time_style: '+x' })).toBe(
      '-rw-r--r-- 1 1K x a.txt\n',
    )
    expect(await line({ g: true, o: true, block_size: '4', time_style: '+x' })).toBe(
      '-rw-r--r-- 1 11 x a.txt\n',
    )
  })

  it('--hyperlink=always wraps the name in OSC 8', async () => {
    expect(await line({ hyperlink: 'always' })).toBe(
      '\x1b]8;;file:///d/a.txt\x07a.txt\x1b]8;;\x07\n',
    )
    expect(await line({ hyperlink: 'auto' })).toBe('a.txt\n')
  })

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

  it('parseFlags: the later of -h and --block-size wins', () => {
    const parse = (flags: Record<string, FlagValue>): boolean =>
      parseFlags(new FlagView(flags, specOf('ls'))).columns.blockSize !== null
    expect(parse({ block_size: 'K', human_readable: true })).toBe(false)
    expect(parse({ human_readable: true, block_size: 'K' })).toBe(true)
    expect(() => parse({ block_size: 'bogus', human_readable: true })).toThrow(UsageError)
  })

  it('parseFlags: -1 never undoes the long format', () => {
    const parse = (flags: Record<string, FlagValue>): boolean =>
      parseFlags(new FlagView(flags, specOf('ls'))).long
    expect(parse({ g: true, args_1: true })).toBe(true)
    expect(parse({ args_l: true, args_1: true })).toBe(true)
    expect(parse({ args_1: true })).toBe(false)
  })

  it.each([
    [{ sort: 'bogus' }, "ls: invalid argument 'bogus' for '--sort'", 1],
    [
      { time: 'bogus' },
      "ls: invalid argument 'bogus' for '--time'\nValid arguments are:\n  - 'atime', 'access', 'use'",
      1,
    ],
    [{ time_style: 'bogus' }, "ls: invalid argument 'bogus' for 'time style'", 2],
    [{ block_size: 'bogus' }, "ls: invalid --block-size argument 'bogus'", 2],
    [{ block_size: '0K' }, "ls: invalid --block-size argument '0K'", 2],
    [{ hyperlink: 'bogus' }, "ls: invalid argument 'bogus' for '--hyperlink'", 1],
  ])('parseFlags refuses in GNU words (%o)', (flags, prefix, code) => {
    let caught: unknown = null
    try {
      parseFlags(new FlagView(flags as Record<string, FlagValue>, specOf('ls')))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect((caught as UsageError).message.startsWith(prefix)).toBe(true)
    expect((caught as UsageError).exitCode).toBe(code)
  })
})

// ls's argument clauses name the refused word through gnulib's quote(), so
// a byte outside 0x20-0x7e comes back escaped rather than interpolated raw.
// Every row measured against GNU coreutils 9.4 under `LC_ALL=C` with a raw
// `bytes` argv (`ls --sort=<w>`, `--time=<w>`, `--hyperlink=<w>`,
// `-l --time-style=<w>`, and `--format=<w>`, which mirage has no option for
// but which renders through the same clause). Mirrors test_ls.py.
describe('ls quotes the word its argument clauses name', () => {
  const words: [string, string][] = [
    ['xé', 'x\\303\\251'],
    ['x\r', 'x\\r'],
    ['x\x01', 'x\\001'],
    ['x\x7f', 'x\\177'],
    ["x'", "x\\'"],
    ['x\\', 'x\\\\'],
  ]
  const clauses: [string, string][] = [
    ['sort', "'--sort'"],
    ['time', "'--time'"],
    ['hyperlink', "'--hyperlink'"],
    ['time_style', "'time style'"],
  ]
  for (const [dest, option] of clauses) {
    it.each(words)(`escapes %j for ${dest}`, (value, escaped) => {
      let message = ''
      try {
        parseFlags(new FlagView({ [dest]: value }, specOf('ls')))
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message.startsWith(`ls: invalid argument '${escaped}' for ${option}\n`)).toBe(true)
    })
  }

  // An EMPTY ARGMATCH value is `ambiguous`, not `invalid`: gnulib's
  // argmatch matches on a prefix and `''` is a prefix of every candidate.
  // Measured on coreutils 9.4 -- `ls --sort=`, `--time=` and
  // `--hyperlink=` are exit 1, `ls -l --time-style=` is exit 2.
  it.each([
    ['sort', "'--sort'", 1],
    ['time', "'--time'", 1],
    ['hyperlink', "'--hyperlink'", 1],
    ['time_style', "'time style'", 2],
  ])('words an empty %s as ambiguous', (dest, option, code) => {
    let caught: unknown = null
    try {
      parseFlags(new FlagView({ [dest]: '' }, specOf('ls')))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect(
      (caught as UsageError).message.startsWith(`ls: ambiguous argument '' for ${option}\n`),
    ).toBe(true)
    expect((caught as UsageError).exitCode).toBe(code)
  })

  // GNU's own `sort_args`: `none time size extension version width`, in
  // that order and with no `name` -- `ls --sort=name` is a refusal on
  // coreutils 9.4, not name order.
  it('lists GNU sort_args and refuses name', () => {
    let caught: unknown = null
    try {
      parseFlags(new FlagView({ sort: 'name' }, specOf('ls')))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect((caught as UsageError).message).toBe(
      "ls: invalid argument 'name' for '--sort'\n" +
        "Valid arguments are:\n  - 'none'\n  - 'time'\n  - 'size'\n" +
        "  - 'extension'\n  - 'version'\n  - 'width'\n" +
        "Try 'ls --help' for more information.",
    )
    expect((caught as UsageError).exitCode).toBe(1)
  })

  // `--block-size` is quoted but NOT escaped, which is GNU's own split:
  // `ls --block-size=1é` reports the two UTF-8 bytes intact, so this
  // clause must not be routed through quote() even though its neighbours
  // above are.
  it.each([['1é'], ['1\x01']])('leaves %j raw for --block-size', (value) => {
    let message = ''
    try {
      parseFlags(new FlagView({ block_size: value, human_readable: true }, specOf('ls')))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message.includes(value)).toBe(true)
  })
})
