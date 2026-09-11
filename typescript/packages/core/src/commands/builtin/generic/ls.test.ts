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
import { LS_FAILURE, LS_MINOR_PROBLEM, LS_OK, exitStatusFor, lsGeneric } from './ls.ts'

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
    expect(await run({ r: true })).toEqual(['apple.txt', 'CHERRY.txt', 'Banana.txt'])
  })

  it('-t sorts newest first by codepoint comparison of modified', async () => {
    expect(await run({ t: true })).toEqual(['apple.txt', 'CHERRY.txt', 'Banana.txt'])
  })

  it('-tr sorts oldest first', async () => {
    expect(await run({ t: true, r: true })).toEqual(['Banana.txt', 'CHERRY.txt', 'apple.txt'])
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
    expect((await runTree(['/a', '/b'], { r: true })).stdout).toBe(
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
    expect((await runTree(['/a'], { R: true })).stdout).toBe('/a:\nf.txt\nsub\n\n/a/sub:\n')
  })

  it('-R does not head a file operand', async () => {
    expect((await runTree(['/a', '/zfile'], { R: true })).stdout).toBe(
      '/zfile\n\n/a:\nf.txt\nsub\n\n/a/sub:\n',
    )
  })

  it('-d sorts its operands and stays unheaded', async () => {
    expect((await runTree(['/zfile', '/b', '/a'], { d: true })).stdout).toBe('/a\n/b\n/zfile\n')
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
      expect(await runTied(['/c', '/a', '/b'], { [sort]: true, r: true })).toBe('/c\n/b\n/a\n')
    })

    it(`-${sort} breaks tied entries on the name`, async () => {
      expect(await runTied(['/'], { [sort]: true })).toBe('a\nb\nc\n')
      expect(await runTied(['/'], { [sort]: true, r: true })).toBe('c\nb\na\n')
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
    expect((await status(['/bad'], { d: true }))[0]).toBe(LS_FAILURE)
    expect((await status(['/good', '/bad'], { d: true }))[0]).toBe(LS_FAILURE)
  })

  it('exits 1 when an entry below the operand cannot be stat', async () => {
    const [code, out] = await status(['/half'])
    expect(code).toBe(LS_MINOR_PROBLEM)
    // The unreadable entry is skipped, not fatal: the listing still renders.
    expect(out).not.toContain('locked.txt')
  })

  it('exits 1 when -R cannot open a subdirectory, keeping parent output', async () => {
    const [code, out] = await status(['/deep'], { R: true })
    expect(code).toBe(LS_MINOR_PROBLEM)
    expect(out).toContain('/deep:')
  })

  it('lets a serious problem outrank a minor one', async () => {
    expect((await status(['/half', '/bad']))[0]).toBe(LS_FAILURE)
  })

  it('prints no header for a -R operand it cannot open', async () => {
    const [code, out] = await status(['/good', '/bad'], { R: true })
    expect(code).toBe(LS_FAILURE)
    expect(out).not.toContain('/bad:')
  })

  it('starts flush left when the first -R operand could not be opened', async () => {
    const [code, out] = await status(['/bad', '/good'], { R: true })
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
        flags: { R: true },
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
        flags: { R: true },
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
        flags: { R: true },
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
        flags: { R: true, F: true },
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
        flags: { F: true },
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
      { flags: { d: true }, cwd: '/', ns: { childMounts } } as never,
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
    await expect(lsGeneric([spec('/x')], opts({ d: true }), readdir, failing)).rejects.toThrow(
      'rate limited',
    )
  })
})
