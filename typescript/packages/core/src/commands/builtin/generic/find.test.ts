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

import { materialize } from '../../../io/types.ts'

import { stripSlash } from '../../../utils/slash.ts'
import { describe, expect, it } from 'vitest'
import type { FindOptions } from '../../../vfs/base.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import type { LinkView } from '../../../view/types.ts'
import { findGeneric as streamFind } from './find.ts'
import { linkResults } from '../../../core/generic/find.ts'

async function findGeneric(...args: Parameters<typeof streamFind>) {
  const result = await streamFind(...args)
  if (result === null) return null
  return [result[0] === null ? null : await materialize(result[0]), result[1]] as const
}

const DEC = new TextDecoder()

function makeOpts(): CommandOpts {
  return { stdin: null, flags: {}, cwd: '/' } as unknown as CommandOpts
}

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

function spec(p: string): PathSpec {
  return new PathSpec({ vfsPath: stripSlash(p), virtual: p, directory: p, resolved: false })
}

function fakeFind(root: PathSpec, _options: FindOptions): Promise<string[]> {
  if (root.virtual === '/missing') return Promise.reject(enoent(root.virtual))
  if (root.virtual === '/limited') return Promise.reject(new Error('rate limited'))
  return Promise.resolve(['/found.txt'])
}

function optsWith(stat: FileStat | null, flags: Record<string, unknown> = {}): CommandOpts {
  return {
    stdin: null,
    flags,
    cwd: '/',
    statPath: () => Promise.resolve(stat),
  } as unknown as CommandOpts
}

describe('generic command find', () => {
  it('skips roots whose find raises ENOENT', async () => {
    const result = await findGeneric([spec('/missing'), spec('/')], [], makeOpts(), fakeFind)
    expect(result).not.toBeNull()
    expect(DEC.decode(result?.[0] ?? undefined)).toBe('/found.txt\n')
  })

  // GNU findutils 4.10.0, pinned on debian:stable-slim:
  //   find <file>             -> <file>   find <file> -type d -> (empty)
  //   find <file> -type f     -> <file>   find <file> -type l -> (empty)
  //   find <file> -maxdepth 0 -> <file>   find <file> -mindepth 1 -> (empty)
  //   find <missing>          -> exit 1, find: '<path>': No such file or directory
  describe('start point that is not a directory', () => {
    const fileStat = {
      name: 'a.txt',
      size: 6,
      type: FileType.FILE,
      content: ContentType.TEXT,
    } as FileStat

    function unreachedFind(): Promise<string[]> {
      throw new Error('find op must not be called for a file start point')
    }

    it.each([null, 0, 1])('-empty requires known zero size (%s)', async (size) => {
      const result = await findGeneric(
        [spec('/mnt/a.txt')],
        [],
        optsWith(new FileStat({ name: 'a.txt', type: FileType.FILE, size }), { empty: true }),
        unreachedFind,
      )
      expect(DEC.decode(result?.[0] ?? undefined)).toBe(size === 0 ? '/mnt/a.txt\n' : '')
    })

    // The flag form passes the value through, so `-type l` (a namespace
    // symlink, which no backend entry ever is) filters instead of reading as
    // "no filter" and printing everything.
    it.each([
      [[], {}, '/mnt/a.txt\n'],
      [['-type', 'f'], {}, '/mnt/a.txt\n'],
      [['-type', 'd'], {}, ''],
      [['-type', 'l'], {}, ''],
      [[], { maxdepth: '0' }, '/mnt/a.txt\n'],
      [[], { mindepth: '1' }, ''],
      [[], { size: '+1c' }, '/mnt/a.txt\n'],
      [[], { size: '+99c' }, ''],
      [[], { name: 'a.txt' }, '/mnt/a.txt\n'],
      [[], { name: 'nope' }, ''],
      [[], { type: 'f' }, '/mnt/a.txt\n'],
      [[], { type: 'd' }, ''],
      [[], { type: 'l' }, ''],
    ])('tests %j %o without asking the backend to walk it', async (texts, flags, expected) => {
      const result = await findGeneric(
        [spec('/mnt/a.txt')],
        texts,
        optsWith(fileStat, flags),
        unreachedFind,
      )
      expect(result?.[1].exitCode).toBe(0)
      expect(DEC.decode(result?.[0] ?? undefined)).toBe(expected)
    })

    it('prints the operand as typed, not the path it resolved to', async () => {
      const linked = new PathSpec({
        vfsPath: 'a.txt',
        virtual: '/mnt/a.txt',
        directory: '/mnt/',
        resolved: true,
        rawPath: '/other/link.txt',
      })
      const result = await findGeneric([linked], [], optsWith(fileStat), unreachedFind)
      expect(DEC.decode(result?.[0] ?? undefined)).toBe('/other/link.txt\n')
    })

    // The probe answers on both channels a backend can offer, so null
    // means nothing is there rather than "this backend's stat could not
    // see it". GNU findutils 4.10.0: exit 1 and the diagnostic below.
    it('names a start point that is not there and exits 1', async () => {
      const root = new PathSpec({
        vfsPath: 'nope',
        virtual: '/mnt/nope',
        directory: '/mnt/',
        resolved: false,
        rawPath: '/mnt/nope',
      })
      const result = await findGeneric([root], [], optsWith(null), unreachedFind)
      expect(result?.[1].exitCode).toBe(1)
      expect(DEC.decode(result?.[0] ?? undefined)).toBe('')
      expect(DEC.decode(result?.[1].stderr as Uint8Array)).toBe(
        "find: '/mnt/nope': No such file or directory\n",
      )
    })

    // A directory that exists only as its children resolves through the
    // probe's readdir channel, so it arrives here as a DIRECTORY and is
    // walked; reporting it as a non-directory row would print the
    // directory and nothing under it on every prefix store.
    it('walks an implicit directory start point', async () => {
      const dirStat = { name: 'logs', type: FileType.DIRECTORY } as FileStat
      const root = new PathSpec({
        vfsPath: 'logs',
        virtual: '/mnt/logs',
        directory: '/mnt/',
        resolved: false,
      })
      const result = await findGeneric([root], [], optsWith(dirStat), () =>
        Promise.resolve(['/logs/child.txt']),
      )
      expect(result?.[1].exitCode).toBe(0)
      // GNU lists the start point before descending, and this op reports
      // descendants only, so the row comes from the generic.
      expect(DEC.decode(result?.[0] ?? undefined)).toBe('/mnt/logs\n/mnt/logs/child.txt\n')
    })

    it('still walks a directory start point', async () => {
      const dirStat = { name: 'mnt', type: FileType.DIRECTORY } as FileStat
      const root = new PathSpec({
        vfsPath: '',
        virtual: '/mnt',
        directory: '/',
        resolved: false,
      })
      const result = await findGeneric([root], [], optsWith(dirStat), () =>
        Promise.resolve(['/a.txt']),
      )
      expect(DEC.decode(result?.[0] ?? undefined)).toBe('/mnt\n/mnt/a.txt\n')
    })
  })

  // GNU findutils 4.10.0, pinned on debian:stable-slim:
  //   find <empty dir>            -> <empty dir>
  //   find <empty dir> -empty     -> <empty dir>
  //   find <empty dir> -not -empty -> (empty)
  describe('directory start point that holds nothing', () => {
    const dirStat = { name: 'mnt', type: FileType.DIRECTORY } as FileStat

    function root(): PathSpec {
      return new PathSpec({
        vfsPath: '',
        virtual: '/mnt',
        directory: '/',
        resolved: false,
      })
    }

    const noRows = (): Promise<string[]> => Promise.resolve([])

    // Without an emptiness probe the backend's own row stands; with one, the
    // backend's row is dropped, not merged (ssh reports every directory as
    // non-empty, so merging would print a directory `-not -empty` must skip).
    it.each([
      [[], {}, [], undefined, '/mnt\n'],
      [[], { empty: true }, [], true, '/mnt\n'],
      [[], { empty: true }, [], false, ''],
      [[], { empty: true }, ['/'], undefined, '/mnt\n'],
      [['-not', '-empty'], {}, ['/'], true, ''],
    ] as const)(
      'answers %j %o over rows %j with the probe saying %s',
      async (texts, flags, rows, empty, expected) => {
        const result = await findGeneric(
          [root()],
          [...texts],
          optsWith(dirStat, flags),
          () => Promise.resolve([...rows]),
          undefined,
          empty === undefined ? undefined : () => Promise.resolve(empty),
        )
        expect(result?.[1].exitCode).toBe(0)
        expect(DEC.decode(result?.[0] ?? undefined)).toBe(expected)
      },
    )

    it('is not empty when it holds only a namespace link', async () => {
      // No backend readdir can see a link, so the probe alone says the
      // directory holds nothing. GNU counts the link as an entry.
      const links = {
        statAt: () => null,
        children: () => [{ name: 'lk', type: FileType.SYMLINK } as FileStat],
        subtree: () => [],
        resolve: (p: string) => p,
        exists: () => Promise.resolve(true),
        targetStat: () => Promise.resolve(null),
      } as unknown as LinkView
      const opts = {
        stdin: null,
        flags: { empty: true },
        cwd: '/',
        statPath: () => Promise.resolve(dirStat),
        ns: { links },
      } as unknown as CommandOpts
      const result = await findGeneric([root()], [], opts, noRows, undefined, () =>
        Promise.resolve(true),
      )
      expect(DEC.decode(result?.[0] ?? undefined)).toBe('')
    })
  })

  it('propagates non-ENOENT errors', async () => {
    await expect(findGeneric([spec('/limited')], [], makeOpts(), fakeFind)).rejects.toThrow(
      'rate limited',
    )
  })

  describe('-mtime reads timestamps through modifiedTs', () => {
    function linkViewOf(modified: string | null): LinkView {
      const st = {
        name: 'l',
        size: 1,
        type: FileType.FILE,
        content: ContentType.TEXT,
        modified,
      } as FileStat
      return {
        statAt: () => null,
        children: () => [],
        subtree: () => [['/l', st]],
        resolve: (p: string) => p,
        exists: () => Promise.resolve(true),
        targetStat: () => Promise.resolve(null),
      }
    }

    async function withMtime(modified: string | null): Promise<string[]> {
      return linkResults(
        linkViewOf(modified),
        '/',
        '',
        '',
        { op: 'true' },
        null,
        null,
        null,
        null,
        0,
        Number.MAX_SAFE_INTEGER,
        false,
      )
    }

    // Date.parse('nonsense') is NaN, and every NaN comparison is false, so
    // both window checks passed and a malformed entry survived where Python
    // drops it; modifiedTs returns null for it, and a date-only stamp reads
    // as midnight UTC rather than NaN.
    it.each([
      ['not-a-date', []],
      ['2025-06-01T12:00:00Z', ['/l']],
      ['2025-06-01', ['/l']],
    ])('reads %s', async (modified, expected) => {
      expect(await withMtime(modified)).toEqual(expected)
    })
  })
})

it('streams the start point before calling a native backend', async () => {
  const result = await streamFind(
    [spec('/remote')],
    [],
    optsWith({ name: 'remote', type: FileType.DIRECTORY } as FileStat),
    () => {
      throw new Error('must not fetch descendants')
    },
  )
  if (result === null) throw new Error('find returned no result')
  const out = result[0] as AsyncGenerator<Uint8Array, void>
  const first = await out.next()
  if (first.done) throw new Error('find returned no start point')
  expect(DEC.decode(first.value)).toBe('/remote\n')
  await out.return(undefined)
})
