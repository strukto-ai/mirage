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
import { FileStat, FileType, PathSpec } from '../../../types.ts'
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
      type: FOLDERS.has(key(p)) ? FileType.DIRECTORY : FileType.TEXT,
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

  const fileStat = new FileStat({ name: 'a.txt', size: 6, type: FileType.TEXT })

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
