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
