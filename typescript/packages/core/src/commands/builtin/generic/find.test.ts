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

import { stripSlash } from '../../../utils/slash.ts'
import { describe, expect, it } from 'vitest'
import type { IOResult } from '../../../io/types.ts'
import type { FindOptions } from '../../../resource/base.ts'
import { ContentType, type FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import type { LinkView } from '../../../ops/types.ts'
import { findGeneric, linkResults } from './find.ts'

const DEC = new TextDecoder()

function makeOpts(): CommandOpts {
  return { stdin: null, flags: {}, filetypeFns: null, cwd: '/' } as unknown as CommandOpts
}

function enoent(p: string): Error {
  const e = new Error(`ENOENT: ${p}`) as Error & { code: string }
  e.code = 'ENOENT'
  return e
}

function spec(p: string): PathSpec {
  return new PathSpec({ resourcePath: stripSlash(p), virtual: p, directory: p, resolved: false })
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
    filetypeFns: null,
    cwd: '/',
    statPath: () => Promise.resolve(stat),
  } as unknown as CommandOpts
}

describe('generic command find', () => {
  it('skips roots whose find raises ENOENT', async () => {
    const result = await findGeneric([spec('/missing'), spec('/')], [], makeOpts(), fakeFind)
    expect(result).not.toBeNull()
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/found.txt\n')
  })

  it('prints start points in operand order without a cross-root sort', async () => {
    // GNU findutils 4.10.0 (debian:stable-slim): each operand's rows print
    // before the next operand's, even when a later root sorts earlier.
    const perRoot = (root: PathSpec): Promise<string[]> =>
      Promise.resolve(root.virtual === '/sub' ? ['/sub/z.txt'] : ['/a.txt'])
    const result = await findGeneric([spec('/sub'), spec('/')], [], makeOpts(), perRoot)
    expect(result?.[1].exitCode).toBe(0)
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/sub/z.txt\n/a.txt\n')
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

    it('reports the file and never asks the backend to walk it', async () => {
      const result = await findGeneric([spec('/mnt/a.txt')], [], optsWith(fileStat), unreachedFind)
      expect(result?.[1].exitCode).toBe(0)
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/mnt/a.txt\n')
    })

    it.each([
      ['f', '/mnt/a.txt\n'],
      ['d', ''],
      ['l', ''],
    ])('honors -type %s', async (kind, expected) => {
      const result = await findGeneric(
        [spec('/mnt/a.txt')],
        ['-type', kind],
        optsWith(fileStat),
        unreachedFind,
      )
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe(expected)
    })

    it.each([
      [{ maxdepth: '0' }, '/mnt/a.txt\n'],
      [{ mindepth: '1' }, ''],
      [{ size: '+1c' }, '/mnt/a.txt\n'],
      [{ size: '+99c' }, ''],
      [{ name: 'a.txt' }, '/mnt/a.txt\n'],
      [{ name: 'nope' }, ''],
      // The flag form passes the value through, so `-type l` (a namespace
      // symlink, which no backend entry ever is) filters instead of reading
      // as "no filter" and printing everything.
      [{ type: 'f' }, '/mnt/a.txt\n'],
      [{ type: 'd' }, ''],
      [{ type: 'l' }, ''],
    ])('honors %o', async (flags, expected) => {
      const result = await findGeneric(
        [spec('/mnt/a.txt')],
        [],
        optsWith(fileStat, flags),
        unreachedFind,
      )
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe(expected)
    })

    it('prints the operand as typed, not the path it resolved to', async () => {
      const linked = new PathSpec({
        resourcePath: 'a.txt',
        virtual: '/mnt/a.txt',
        directory: '/mnt/',
        resolved: true,
        rawPath: '/other/link.txt',
      })
      const result = await findGeneric([linked], [], optsWith(fileStat), unreachedFind)
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/other/link.txt\n')
    })

    // The probe answers on both channels a backend can offer, so null
    // means nothing is there rather than "this backend's stat could not
    // see it". GNU findutils 4.10.0: exit 1 and the diagnostic below.
    it('names a start point that is not there and exits 1', async () => {
      const root = new PathSpec({
        resourcePath: 'nope',
        virtual: '/mnt/nope',
        directory: '/mnt/',
        resolved: false,
        rawPath: '/mnt/nope',
      })
      const result = await findGeneric([root], [], optsWith(null), unreachedFind)
      expect(result?.[1].exitCode).toBe(1)
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('')
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
        resourcePath: 'logs',
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
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/mnt/logs\n/mnt/logs/child.txt\n')
    })

    it('still walks a directory start point', async () => {
      const dirStat = { name: 'mnt', type: FileType.DIRECTORY } as FileStat
      const root = new PathSpec({
        resourcePath: '',
        virtual: '/mnt',
        directory: '/',
        resolved: false,
      })
      const result = await findGeneric([root], [], optsWith(dirStat), () =>
        Promise.resolve(['/a.txt']),
      )
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/mnt\n/mnt/a.txt\n')
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
        resourcePath: '',
        virtual: '/mnt',
        directory: '/',
        resolved: false,
      })
    }

    const noRows = (): Promise<string[]> => Promise.resolve([])

    it('is reported even though the listing is empty', async () => {
      const result = await findGeneric([root()], [], optsWith(dirStat), noRows)
      expect(result?.[1].exitCode).toBe(0)
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/mnt\n')
    })

    it('matches -empty, answered by a listing rather than a guess', async () => {
      const result = await findGeneric(
        [root()],
        [],
        optsWith(dirStat, { empty: true }),
        noRows,
        undefined,
        () => Promise.resolve(true),
      )
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/mnt\n')
    })

    it('fails -empty when it has children', async () => {
      const result = await findGeneric(
        [root()],
        [],
        optsWith(dirStat, { empty: true }),
        noRows,
        undefined,
        () => Promise.resolve(false),
      )
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('')
    })

    it('keeps the backend row when emptiness cannot be asked', async () => {
      // `-empty` on a directory needs a listing, which a bespoke wrapper need
      // not wire. Replacing the row there would trade a backend's answer for
      // "unknown", so the row is left alone.
      const result = await findGeneric([root()], [], optsWith(dirStat, { empty: true }), () =>
        Promise.resolve(['/']),
      )
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/mnt\n')
    })

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
        filetypeFns: null,
        cwd: '/',
        statPath: () => Promise.resolve(dirStat),
        ns: { links },
      } as unknown as CommandOpts
      const result = await findGeneric([root()], [], opts, noRows, undefined, () =>
        Promise.resolve(true),
      )
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('')
    })

    it('replaces the backend row for the start point', async () => {
      // ssh reports every directory as non-empty, so merging would keep its
      // row and print a directory that `-not -empty` must skip.
      const result = await findGeneric(
        [root()],
        ['-not', '-empty'],
        optsWith(dirStat),
        () => Promise.resolve(['/']),
        undefined,
        () => Promise.resolve(true),
      )
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('')
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

    it('drops a malformed timestamp instead of keeping it', async () => {
      // Date.parse('nonsense') is NaN, and every NaN comparison is false,
      // so both window checks passed and the entry survived — where Python
      // drops it. modifiedTs returns null for the same input.
      expect(await withMtime('not-a-date')).toEqual([])
    })

    it('keeps an entry whose timestamp is inside the window', async () => {
      expect(await withMtime('2025-06-01T12:00:00Z')).toEqual(['/l'])
    })

    it('reads a date-only stamp as midnight UTC rather than NaN', async () => {
      expect(await withMtime('2025-06-01')).toEqual(['/l'])
    })
  })

  it.each([
    ['maxdepth', 'abc', '-maxdepth'],
    ['mindepth', 'xx', '-mindepth'],
    ['size', '', '-size'],
    ['size', 'abc', '-size'],
    ['mtime', 'abc', '-mtime'],
  ])('exits 1 with clean stderr for invalid %s=%s', async (flag, value, label) => {
    const opts = {
      stdin: null,
      flags: { [flag]: value },
      filetypeFns: null,
      cwd: '/',
    } as unknown as CommandOpts
    const result = await findGeneric([spec('/')], [], opts, fakeFind)
    expect(result).not.toBeNull()
    const [out, io] = result as [Uint8Array | null, IOResult]
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      `find: invalid argument '${value}' to '${label}'\n`,
    )
  })
})
