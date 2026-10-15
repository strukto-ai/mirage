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
import { type ByteSource, IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { checksumGeneric, hashSource } from './checksum.ts'

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

function opts(flags: Record<string, string | boolean | number | string[]>, cwd = '/'): CommandOpts {
  return { stdin: null, flags, cwd, vfs: {} } as CommandOpts
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

// Content-addressed fake: the digest of a body is '5a' + the body's text,
// zero-padded to an md5's 32 digits, which parseCheckLine accepts as hex
// when bodies are hex-safe.
const hasher = async (source: ByteSource): Promise<string> =>
  `5a${DEC.decode(await materialize(source))}`.padEnd(32, '0')
const DIGEST = '5aabc'.padEnd(32, '0')

async function runCheck(
  files: Record<string, string>,
  flags: Record<string, string | boolean | number | string[]> = {},
  cwd = '/',
  paths: string[] = ['/sums.txt'],
): Promise<[string, string, number]> {
  const result = await checksumGeneric(
    paths.map(spec),
    opts({ check: true, ...flags }, cwd),
    makeStream(files),
    hasher,
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
      checksumGeneric([spec('/sums.txt')], opts({ check: true }), stream, hasher, 'md5sum'),
    ).rejects.toThrow('403 Forbidden')
  })
})

describe('a stored digest', () => {
  const fake = async (b: ByteSource): Promise<string> => `h${DEC.decode(await materialize(b))}`

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
      opts({}),
      read,
      fake,
      'md5sum',
      () => Promise.resolve(null),
      stored,
    )
    expect(DEC.decode(await materialize(result?.[0] ?? null))).toBe(
      `${'f'.repeat(32)}  /a\nhabc  /b\n`,
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
      opts({ check: true }),
      makeStream({ '/list': `${DIGEST}  /f\n`, '/f': 'abc' }),
      hasher,
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
    opts({}),
    makeStream({}),
    hasher,
    'md5sum',
    () => Promise.resolve(null),
    stored,
  )
  const [out, io] = result ?? [null, new IOResult()]
  expect(DEC.decode(await materialize(out))).toBe(`${'f'.repeat(32)}  /a\n${'f'.repeat(32)}  /c\n`)
  expect(io.exitCode).toBe(1)
  expect(DEC.decode(await materialize(io.stderr))).toBe('md5sum: /b: No such file or directory\n')
})

it.each([
  ['md5', '900150983cd24fb0d6963f7d28e17f72'],
  ['sha1', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
  ['sha256', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'sha384',
    'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
  ],
  [
    'sha512',
    'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
  ],
])('hashes split input with %s and closes the source', async (algorithm, expected) => {
  let closed = false
  async function* source(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    try {
      for (const char of 'abc') yield ENC.encode(char)
    } finally {
      closed = true
    }
  }
  expect(await hashSource(source(), algorithm)).toBe(expected)
  expect(closed).toBe(true)
})
