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
// Mirrors python/tests/commands/builtin/generic/test_gzip.py.

import { expect, it } from 'vitest'
import { eacces, enoent } from '../../../errors/fs.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { Files } from '../../../workspace/files.ts'
import { type Context } from '../../config.ts'
import { type LinkResolver } from '../utils/links.ts'
import { inputInfo } from './decompress.ts'
import { gzipGeneric } from './gzip.ts'
import { gunzip } from '../../../utils/compress.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { materialize } from '../../../io/types.ts'

it.each([false, true])('compression skips suffixes or reports late errors: %s', async (skipped) => {
  const reads: string[] = []
  const writes = new Map<string, Uint8Array>()
  const removed: string[] = []
  const name = skipped ? '/bad.gz' : '/bad'
  async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    reads.push(path.virtual)
    yield new TextEncoder().encode('hello\n')
    if (path.virtual === name) {
      reads.push('continued')
      throw eacces(path)
    }
  }
  const result = await gzipGeneric(
    [PathSpec.fromStrPath(name), PathSpec.fromStrPath('/good')],
    { flags: {}, stdin: null, cwd: PathSpec.fromStrPath('/') },
    read,
    async (path, data) => {
      writes.set(path.virtual, await materialize(data))
    },
    (path) => {
      removed.push(path.virtual)
      return Promise.resolve()
    },
  )
  if (result === null) throw new Error('gzip returned no result')
  const [, io] = result
  expect(io.exitCode).toBe(skipped ? 0 : 1)
  expect(await io.stderrStr()).toBe(
    skipped
      ? 'gzip: /bad.gz already has .gz suffix -- unchanged\n'
      : '\ngzip: /bad: Permission denied\n',
  )
  expect(reads).toEqual(skipped ? [name, '/good'] : [name, 'continued'])
  expect(removed).toEqual(skipped ? ['/good'] : [])
  expect([...writes.keys()]).toEqual(skipped ? ['/good.gz'] : [])
  if (skipped) {
    const output = writes.get('/good.gz')
    if (output === undefined) throw new Error('gzip did not write the next file')
    expect(await gunzip(output)).toEqual(new TextEncoder().encode('hello\n'))
  }
})

it('compression stores the input time and keeps its attributes', async () => {
  const writes = new Map<string, Uint8Array>()
  const attrs: [string, unknown][] = []
  async function* read(): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    yield new TextEncoder().encode('hello\n')
  }
  for (const flags of [{}, { no_name: true }]) {
    const result = await gzipGeneric(
      [PathSpec.fromStrPath('/f')],
      { flags, stdin: null, cwd: PathSpec.fromStrPath('/') },
      read,
      async (path, data) => {
        writes.set(path.virtual, await materialize(data))
      },
      () => Promise.resolve(),
      (path) =>
        path.virtual === '/f.gz'
          ? Promise.reject(enoent(path))
          : Promise.resolve(
              new FileStat({
                name: 'f',
                type: FileType.FILE,
                mode: 0o100640,
                modified: '2001-02-03T04:05:06Z',
              }),
            ),
      undefined,
      (path, fields) => {
        attrs.push([path.virtual, fields])
        return Promise.resolve()
      },
    )
    if (result === null) throw new Error('gzip returned no result')
    expect(result[1].exitCode).toBe(0)
    const stamp = [...(writes.get('/f.gz') ?? new Uint8Array()).subarray(4, 8)]
    expect(stamp).toEqual('no_name' in flags ? [0, 0, 0, 0] : [0x72, 0x83, 0x7b, 0x3a])
  }
  expect(attrs[0]).toEqual(['/f.gz', { mode: 0o640, mtime: '2001-02-03T04:05:06Z' }])
})

const UNDATED = 'gzip: /f: warning: file timestamp out of range for gzip format\n'

async function dated(
  modified: string,
  flags: Record<string, boolean> = {},
  taken = false,
): Promise<[Uint8Array | undefined, number, string]> {
  const writes = new Map<string, Uint8Array>()
  // eslint-disable-next-line @typescript-eslint/require-await
  async function* read(): AsyncIterable<Uint8Array> {
    yield new TextEncoder().encode('hello\n')
  }
  const result = await gzipGeneric(
    [PathSpec.fromStrPath('/f')],
    { flags, stdin: null, cwd: PathSpec.fromStrPath('/') },
    read,
    async (path, data) => {
      writes.set(path.virtual, await materialize(data))
    },
    () => Promise.resolve(),
    (path) =>
      path.virtual === '/f.gz' && !taken
        ? Promise.reject(enoent(path))
        : Promise.resolve(new FileStat({ name: 'f', type: FileType.FILE, modified })),
  )
  if (result === null) throw new Error('gzip returned no result')
  const [body, io] = result
  if (body !== null) writes.set('/f.gz', await materialize(body as AsyncIterable<Uint8Array>))
  return [writes.get('/f.gz'), io.exitCode, await io.stderrStr()]
}

it.each([
  ['1960-01-01T00:00:00Z', {}, [0, 0, 0, 0], 2, UNDATED],
  ['2200-01-01T00:00:00Z', {}, [0, 0, 0, 0], 2, UNDATED],
  ['1970-01-01T00:00:00Z', {}, [0, 0, 0, 0], 2, UNDATED],
  ['1970-01-01T00:00:00.500Z', {}, [0, 0, 0, 0], 2, UNDATED],
  ['1960-01-01T00:00:00Z', { quiet: true }, [0, 0, 0, 0], 2, ''],
  ['1960-01-01T00:00:00Z', { stdout: true }, [0, 0, 0, 0], 2, UNDATED],
  ['1960-01-01T00:00:00Z', { no_name: true }, [0, 0, 0, 0], 0, ''],
  ['2106-02-07T06:28:15Z', {}, [255, 255, 255, 255], 0, ''],
  ['1970-01-01T00:00:01Z', {}, [1, 0, 0, 0], 0, ''],
])(
  'keeps a date the header cannot hold out of it: %s %j',
  async (when, flags, stamp, code, err) => {
    const [written, status, said] = await dated(when, flags)
    expect([[...(written ?? new Uint8Array()).subarray(4, 8)], status, said]).toEqual([
      stamp,
      code,
      err,
    ])
  },
)

it('puts the date warning after the name -v started', async () => {
  const [, status, said] = await dated('1960-01-01T00:00:00Z', { verbose: true })
  const [first, second, end] = said.split('\n')
  expect(first).toBe(`/f:\t${UNDATED.trimEnd()}`)
  expect(second?.endsWith('-- replaced with /f.gz')).toBe(true)
  expect([end, status]).toEqual(['', 2])
})

it('refuses an output already there before the date warning', async () => {
  const [written, status, said] = await dated('1960-01-01T00:00:00Z', {}, true)
  expect([written, status, said]).toEqual([
    undefined,
    2,
    'gzip: /f.gz already exists;\tnot overwritten\n',
  ])
})

it('asks the mount before -r touches a file', async () => {
  const touched: string[] = []
  // eslint-disable-next-line @typescript-eslint/require-await
  async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
    touched.push(path.virtual)
    yield new TextEncoder().encode('x')
  }
  const dispatch = (name: string, path: PathSpec): Promise<never> => {
    expect([name, path.virtual]).toEqual(['before_full_walk', '/d'])
    return Promise.reject(new Error('more than 1 files in scope (walk_limit); narrow the path'))
  }
  await expect(
    gzipGeneric(
      [PathSpec.fromStrPath('/d')],
      {
        flags: { recursive: true },
        stdin: null,
        cwd: PathSpec.fromStrPath('/'),
        vfs: new Files(dispatch as unknown as DispatchFn, null, null, { ledger: false }),
      } as unknown as Context,
      read,
      () => Promise.resolve(),
      () => Promise.resolve(),
      (path) =>
        Promise.resolve(
          new FileStat({
            name: 'n',
            type: path.virtual === '/d' ? FileType.DIRECTORY : FileType.FILE,
          }),
        ),
      () => Promise.resolve(['/d/a', '/d/b']),
    ),
  ).rejects.toThrow('gzip: more than 1 files')
  expect(touched).toEqual([])
})

it('reads what a followed link leads to', async () => {
  const resolver = {
    target: (): string => '/secret',
    stat: (virtual: string): Promise<FileStat> => {
      expect(virtual).toBe('/secret')
      return Promise.resolve(new FileStat({ name: 's', type: FileType.FILE, mode: 0o100600 }))
    },
  } as unknown as LinkResolver
  const info = await inputInfo(
    () => Promise.resolve(new FileStat({ name: 'l', type: FileType.SYMLINK })),
    PathSpec.fromStrPath('/d/link'),
    '/d/link',
    resolver,
  )
  expect(info?.mode).toBe(0o100600)
})
