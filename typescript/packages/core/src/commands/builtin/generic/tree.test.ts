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
import { ContentType, FileStat, FileType, PathSpec } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { CommandOpts } from '../../config.ts'
import { treeGeneric } from './tree.ts'

const DEC = new TextDecoder()

const FOLDERS = new Set(['/', '/docs', '/.secret'])

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
  const [out] = (await treeGeneric([spec('/')], opts(flags), readdir, stat)) as [
    Uint8Array,
    unknown,
  ]
  return DEC.decode(out)
}

describe('treeGeneric with trailing-slash folder entries', () => {
  it('shows folder names and hides hidden folders by default', async () => {
    expect(await run(boxReaddir, {})).toBe(
      '/\n|-- docs\n|   `-- a.txt\n`-- readme.txt\n\n2 directories, 2 files\n',
    )
  })

  it('shows hidden folders by name with -a', async () => {
    expect(await run(boxReaddir, { a: true })).toBe(
      '/\n|-- .secret\n|-- docs\n|   `-- a.txt\n`-- readme.txt\n\n3 directories, 2 files\n',
    )
  })

  it('produces identical output for slash-free entries', async () => {
    expect(await run(s3Readdir, {})).toBe(
      '/\n|-- docs\n|   `-- a.txt\n`-- readme.txt\n\n2 directories, 2 files\n',
    )
  })
})

// GNU tree 2.2.1, pinned on debian:stable-slim. A file operand gets the
// same inline marker an unopenable one does, but it exists, so it is
// counted and the exit status stays 0:
//   tree <file>     -> "<file>  [error opening dir]", 0 directories, 1 file, 0
//   tree -d <file>  -> same marker, "0 directories", exit 0
//   tree <missing>  -> same marker, 0 directories, 0 files, exit 2
describe('treeGeneric operand that is not a directory', () => {
  function optsWith(
    start: FileStat | null,
    flags: Record<string, string | boolean> = {},
  ): CommandOpts {
    return {
      stdin: null,
      flags,
      filetypeFns: null,
      cwd: '/',
      resource: null,
      statPath: () => Promise.resolve(start),
    } as unknown as CommandOpts
  }

  const unreached = (): Promise<never> => {
    throw new Error('a non-directory operand must not be listed')
  }

  const fileStat = new FileStat({
    name: 'a.txt',
    size: 6,
    type: FileType.FILE,
    content: ContentType.TEXT,
  })

  it('counts a file operand and exits 0', async () => {
    const [out, io] = (await treeGeneric(
      [spec('/a.txt')],
      optsWith(fileStat),
      unreached,
      unreached,
    )) as [Uint8Array, { exitCode: number }]
    expect(io.exitCode).toBe(0)
    expect(DEC.decode(out)).toBe('/a.txt  [error opening dir]\n\n0 directories, 1 file\n')
  })

  it('omits the file count under -d', async () => {
    const [out, io] = (await treeGeneric(
      [spec('/a.txt')],
      optsWith(fileStat, { d: true }),
      unreached,
      unreached,
    )) as [Uint8Array, { exitCode: number }]
    expect(io.exitCode).toBe(0)
    expect(DEC.decode(out)).toBe('/a.txt  [error opening dir]\n\n0 directories\n')
  })

  // The probe answers on both channels a backend can offer, so null means
  // nothing is there and the walk is never attempted. GNU tree 2.2.1 marks
  // it inline, counts nothing, and exits 2.
  it('marks an operand that is not there and exits 2', async () => {
    const [out, io] = (await treeGeneric(
      [spec('/nope')],
      optsWith(null),
      unreached,
      unreached,
    )) as [Uint8Array, { exitCode: number }]
    expect(io.exitCode).toBe(2)
    expect(DEC.decode(out)).toBe('/nope  [error opening dir]\n\n0 directories, 0 files\n')
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

  // A MountView double: ROOT is the mount, `hidden` says whether this
  // session may be told about it.
  function crossOpts(hidden = false): CommandOpts {
    const under = (path: string): string[] =>
      [ROOT].filter((r) => r.startsWith(rstripSlash(path) + '/'))
    return {
      ...opts({}),
      ns: {
        mounts: {
          descendants: under,
          visibleDescendants: (path: string) => (hidden ? [] : under(path)),
          isRoot: (path: string) => rstripSlash(path) === ROOT,
          rootOf: () => '/',
        },
      },
      readdirPath: (virtual: string) => Promise.resolve(listing(owner(virtual), virtual)),
      statPath: (virtual: string) => {
        const type = owner(virtual)[virtual]
        return Promise.resolve(
          type === undefined ? null : new FileStat({ name: virtual.split('/').pop() ?? '', type }),
        )
      },
    } as unknown as CommandOpts
  }

  // Real tree draws the mounted filesystem's entries under the mount
  // point, never the ones it covers, and counts the whole thing once
  // (pinned on tree 2.2.1 over a tmpfs at the same spot). Concatenating a
  // per-mount run cannot do that: it would print two roots and two
  // summaries.
  it('draws the mounted entries and none of the covered ones', async () => {
    const [out] = (await treeGeneric(
      [spec('/base')],
      crossOpts(),
      backendReaddir,
      backendStat,
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

  it('never draws a mount the session cannot see', async () => {
    // A crossing row is drawn from the mount table alone, so no backend
    // and no dispatcher gets a chance to refuse it: `tree` has to read
    // the list of mounts it may name rather than the list it may not
    // descend into. The parent holds no key of its own under the mount
    // root here, so the only way `inner` could be drawn is the table.
    const bare: Record<string, FileType> = {
      '/base': FileType.DIRECTORY,
      '/base/top.txt': FileType.FILE,
    }
    const [out, io] = (await treeGeneric(
      [spec('/base')],
      crossOpts(true),
      (p: PathSpec) => Promise.resolve(listing(bare, key(p))),
      (p: PathSpec) => {
        const type = bare[key(p)]
        if (type === undefined) return Promise.reject(new Error(`ENOENT ${key(p)}`))
        return Promise.resolve(new FileStat({ name: key(p).split('/').pop() ?? '', type }))
      },
    )) as [Uint8Array, { exitCode: number }]
    expect(DEC.decode(out)).toBe(['/base', '`-- top.txt', '', '1 directory, 1 file', ''].join('\n'))
    expect(io.exitCode).toBe(0)
  })

  it('stops at the mount point under -L 1', async () => {
    const withDepth = { ...crossOpts(), flags: { L: '1' } } as unknown as CommandOpts
    const [out] = (await treeGeneric([spec('/base')], withDepth, backendReaddir, backendStat)) as [
      Uint8Array,
      unknown,
    ]
    expect(DEC.decode(out)).toBe(
      ['/base', '|-- inner', '`-- top.txt', '', '2 directories, 1 file', ''].join('\n'),
    )
  })
})
