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
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { Context } from '../../config.ts'
import { checksumGeneric } from './checksum.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function spec(path: string): PathSpec {
  return new PathSpec({
    vfsPath: stripSlash(path),
    virtual: path,
    directory: path,
    resolved: true,
    rawPath: path,
  })
}

function ctx(flags: Record<string, string | boolean | number | string[]>, cwd = '/'): Context {
  return { stdin: null, flags, cwd: PathSpec.fromStrPath(cwd) } as Context
}

function makeStream(files: Record<string, string>) {
  return function stream(p: PathSpec): AsyncIterable<Uint8Array> {
    const content = files[p.virtual]
    async function* gen(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      if (content === undefined) {
        const err = new Error(p.virtual) as Error & { code: string }
        err.code = 'ENOENT'
        throw err
      }
      yield ENC.encode(content)
    }
    return gen()
  }
}

// The md5 of 'abc'.
const DIGEST = '900150983cd24fb0d6963f7d28e17f72'

async function runCheck(
  files: Record<string, string>,
  flags: Record<string, string | boolean | number | string[]> = {},
  cwd = '/',
  paths: string[] = ['/sums.txt'],
): Promise<[string, string, number]> {
  const result = await checksumGeneric(
    paths.map(spec),
    ctx({ check: true, ...flags }, cwd),
    makeStream(files),
    'md5sum',
  )
  const [out, io] = result ?? [null, new IOResult()]
  return [
    out === null ? '' : DEC.decode(await materialize(out)),
    DEC.decode(await materialize(io.stderr)),
    io.exitCode,
  ]
}

// GNU coreutils 9.7, pinned on debian:stable-slim: the per-file strerror
// lines and the WARNING block are stderr, FAILED lines are stdout, and
// --status silences everything except the strerror lines.
describe('checksum --check', () => {
  const missingOne = { '/sums.txt': `${DIGEST}  /ok.txt\n${DIGEST}  /miss.txt\n`, '/ok.txt': 'abc' }

  it.each([
    [
      {},
      [
        '/ok.txt: OK\n/miss.txt: FAILED open or read\n',
        'md5sum: /miss.txt: No such file or directory\n' +
          'md5sum: WARNING: 1 listed file could not be read\n',
        1,
      ],
    ],
    [{ status: true }, ['', 'md5sum: /miss.txt: No such file or directory\n', 1]],
  ])('reports a missing recorded file under %j', async (flags, expected) => {
    expect(await runCheck(missingOne, flags)).toEqual(expected)
  })

  it('propagates a read failure that is not a filesystem error', async () => {
    const raw = new Error('S3 GET f failed: 403 Forbidden')
    function stream(p: PathSpec): AsyncIterable<Uint8Array> {
      async function* gen(): AsyncIterable<Uint8Array> {
        await Promise.resolve()
        if (p.virtual === '/sums.txt') {
          yield ENC.encode(`${DIGEST}  /f.txt\n`)
          return
        }
        throw raw
      }
      return gen()
    }
    await expect(
      checksumGeneric([spec('/sums.txt')], ctx({ check: true }), stream, 'md5sum'),
    ).rejects.toThrow('403 Forbidden')
  })
})

describe('a stored digest', () => {
  // Mirrors python's test_a_stored_digest_stands_in_for_the_read.
  it('stands in for the read', async () => {
    const reads: string[] = []
    const asked: [string, string][] = []
    const read = (p: PathSpec): AsyncIterable<Uint8Array> => {
      reads.push(p.virtual)
      return makeStream({ '/b': 'abc' })(p)
    }
    const stored = (p: PathSpec, algorithm: string): Promise<string | null> => {
      asked.push([p.virtual, algorithm])
      return Promise.resolve(p.virtual === '/a' ? 'f'.repeat(32) : null)
    }
    const result = await checksumGeneric(
      [spec('/a'), spec('/b')],
      ctx({}),
      read,
      'md5sum',
      () => Promise.resolve(null),
      stored,
    )
    expect(DEC.decode(await materialize(result?.[0] ?? null))).toBe(
      `${'f'.repeat(32)}  /a\n${DIGEST}  /b\n`,
    )
    expect(asked).toEqual([
      ['/a', 'md5'],
      ['/b', 'md5'],
    ])
    expect(reads).toEqual(['/b'])
  })

  // Mirrors python's test_check_reads_the_bytes_and_asks_no_stored_digest.
  it('is never asked under -c', async () => {
    const stored = (): Promise<string | null> => Promise.reject(new Error('asked under -c'))
    const result = await checksumGeneric(
      [spec('/list')],
      ctx({ check: true }),
      makeStream({ '/list': `${DIGEST}  /f\n`, '/f': 'abc' }),
      'md5sum',
      () => Promise.resolve(null),
      stored,
    )
    expect(DEC.decode(await materialize(result?.[0] ?? null))).toBe('/f: OK\n')
  })
})

// Mirrors python's test_a_failed_stored_digest_is_reported_and_the_rest_hash.
it('reports a failed stored digest and hashes the rest', async () => {
  const stored = (p: PathSpec): Promise<string | null> =>
    p.virtual === '/b'
      ? Promise.reject(Object.assign(new Error('/b'), { code: 'ENOENT' }))
      : Promise.resolve('f'.repeat(32))
  const result = await checksumGeneric(
    [spec('/a'), spec('/b'), spec('/c')],
    ctx({}),
    makeStream({}),
    'md5sum',
    () => Promise.resolve(null),
    stored,
  )
  const [out, io] = result ?? [null, new IOResult()]
  expect(DEC.decode(await materialize(out))).toBe(`${'f'.repeat(32)}  /a\n${'f'.repeat(32)}  /c\n`)
  expect(io.exitCode).toBe(1)
  expect(DEC.decode(await materialize(io.stderr))).toBe('md5sum: /b: No such file or directory\n')
})
