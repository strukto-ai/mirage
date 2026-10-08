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
import type { CommandOpts } from '../../config.ts'
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
const hasher = (bytes: Uint8Array): Promise<string> =>
  Promise.resolve(`5a${DEC.decode(bytes)}`.padEnd(32, '0'))
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
