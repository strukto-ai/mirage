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
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { findGeneric } from './find.ts'

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

describe('generic command find', () => {
  it('skips roots whose find raises ENOENT', async () => {
    const result = await findGeneric([spec('/missing'), spec('/')], [], makeOpts(), fakeFind)
    expect(result).not.toBeNull()
    expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/found.txt\n')
  })

  // GNU findutils 4.10.0, pinned on debian:stable-slim:
  //   find <file>             -> <file>   find <file> -type d -> (empty)
  //   find <file> -type f     -> <file>   find <file> -type l -> (empty)
  //   find <file> -maxdepth 0 -> <file>   find <file> -mindepth 1 -> (empty)
  //   find <missing>          -> exit 1, find: '<path>': No such file or directory
  describe('start point that is not a directory', () => {
    const fileStat = { name: 'a.txt', size: 6, type: FileType.TEXT } as FileStat

    function optsWith(stat: FileStat | null, flags: Record<string, unknown> = {}): CommandOpts {
      return {
        stdin: null,
        flags,
        filetypeFns: null,
        cwd: '/',
        statPath: () => Promise.resolve(stat),
      } as unknown as CommandOpts
    }

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
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/mnt/logs/child.txt\n')
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
      expect(DEC.decode(result?.[0] as Uint8Array)).toBe('/mnt/a.txt\n')
    })
  })

  it('propagates non-ENOENT errors', async () => {
    await expect(findGeneric([spec('/limited')], [], makeOpts(), fakeFind)).rejects.toThrow(
      'rate limited',
    )
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
