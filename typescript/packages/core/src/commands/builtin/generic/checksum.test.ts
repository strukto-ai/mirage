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
    resourcePath: stripSlash(path),
    virtual: path,
    directory: path,
    resolved: true,
    rawPath: path,
  })
}

function opts(flags: Record<string, string | boolean | number | string[]>, cwd = '/'): CommandOpts {
  return { stdin: null, flags, filetypeFns: null, cwd, resource: {} } as CommandOpts
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
// which parseCheckLine accepts as hex when bodies are hex-safe.
const hasher = (bytes: Uint8Array): Promise<string> => Promise.resolve(`5a${DEC.decode(bytes)}`)

async function runCheck(
  files: Record<string, string>,
  flags: Record<string, string | boolean | number | string[]> = {},
  cwd = '/',
): Promise<[string, string, number]> {
  const result = await checksumGeneric(
    [spec('/sums.txt')],
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
  it('reports a missing recorded file on both channels and exits 1', async () => {
    const [out, err, code] = await runCheck({
      '/sums.txt': '5aabc  /ok.txt\n5aabc  /miss.txt\n',
      '/ok.txt': 'abc',
    })
    expect(out).toBe('/ok.txt: OK\n/miss.txt: FAILED open or read\n')
    expect(err).toBe(
      'md5sum: /miss.txt: No such file or directory\n' +
        'md5sum: WARNING: 1 listed file could not be read\n',
    )
    expect(code).toBe(1)
  })

  it('resolves a relative recorded name against the cwd', async () => {
    const [out, err, code] = await runCheck(
      { '/sums.txt': '5aabc  f.txt\n', '/data/f.txt': 'abc' },
      {},
      '/data',
    )
    expect(out).toBe('f.txt: OK\n')
    expect(err).toBe('')
    expect(code).toBe(0)
  })

  it('propagates a read failure that is not a filesystem error', async () => {
    const raw = new Error('S3 GET f failed: 403 Forbidden')
    function stream(p: PathSpec): AsyncIterable<Uint8Array> {
      async function* gen(): AsyncIterable<Uint8Array> {
        await Promise.resolve()
        if (p.virtual === '/sums.txt') {
          yield ENC.encode('5aabc  /f.txt\n')
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

  it('counts mismatches into the NOT-match warning', async () => {
    const [out, err, code] = await runCheck({
      '/sums.txt': '5aface  /a.txt\n5aface  /b.txt\n',
      '/a.txt': 'face',
      '/b.txt': 'cafe',
    })
    expect(out).toBe('/a.txt: OK\n/b.txt: FAILED\n')
    expect(err).toBe('md5sum: WARNING: 1 computed checksum did NOT match\n')
    expect(code).toBe(1)
  })

  it('fails alone when no line is properly formatted', async () => {
    const [out, err, code] = await runCheck({ '/sums.txt': 'junk\nmore junk\n' })
    expect(out).toBe('')
    expect(err).toBe('md5sum: /sums.txt: no properly formatted checksum lines found\n')
    expect(code).toBe(1)
  })

  it('reports nothing verified under --ignore-missing when all are missing', async () => {
    const [out, err, code] = await runCheck(
      { '/sums.txt': '5aabc  /gone.txt\n' },
      { ignore_missing: true },
    )
    expect(out).toBe('')
    expect(err).toBe('md5sum: /sums.txt: no file was verified\n')
    expect(code).toBe(1)
  })

  it('--status silences no-file-verified but keeps its exit 1', async () => {
    const [out, err, code] = await runCheck(
      { '/sums.txt': '5aabc  /gone.txt\n' },
      { ignore_missing: true, status: true },
    )
    expect(out).toBe('')
    expect(err).toBe('')
    expect(code).toBe(1)
  })

  it('--status keeps the no-properly-formatted fatal', async () => {
    const [out, err, code] = await runCheck({ '/sums.txt': 'junk\n' }, { status: true })
    expect(out).toBe('')
    expect(err).toBe('md5sum: /sums.txt: no properly formatted checksum lines found\n')
    expect(code).toBe(1)
  })

  it('a malformed line plus an ignored skip is no-file-verified', async () => {
    // A parsed line whose target --ignore-missing skips must not read as
    // "no properly formatted checksum lines found".
    const [out, err, code] = await runCheck(
      { '/sums.txt': 'junk\n5aabc  /gone.txt\n' },
      { ignore_missing: true },
    )
    expect(out).toBe('')
    expect(err).toBe(
      'md5sum: WARNING: 1 line is improperly formatted\n' +
        'md5sum: /sums.txt: no file was verified\n',
    )
    expect(code).toBe(1)
  })

  it('--ignore-missing with only a mismatch reports both diagnostics', async () => {
    // GNU: zero OK lines under --ignore-missing is "no file was verified"
    // even when a mismatch was read and reported.
    const [out, err, code] = await runCheck(
      { '/sums.txt': '5aface  /a.txt\n', '/a.txt': 'cafe' },
      { ignore_missing: true },
    )
    expect(out).toBe('/a.txt: FAILED\n')
    expect(err).toBe(
      'md5sum: WARNING: 1 computed checksum did NOT match\n' +
        'md5sum: /sums.txt: no file was verified\n',
    )
    expect(code).toBe(1)
  })

  it('--status keeps the strerror lines and drops the summaries', async () => {
    const [out, err, code] = await runCheck(
      { '/sums.txt': '5aabc  /ok.txt\n5aabc  /miss.txt\n', '/ok.txt': 'abc' },
      { status: true },
    )
    expect(out).toBe('')
    expect(err).toBe('md5sum: /miss.txt: No such file or directory\n')
    expect(code).toBe(1)
  })

  it('--warn adds per-line diagnostics and the summary prints regardless', async () => {
    const [out, err, code] = await runCheck(
      { '/sums.txt': 'bad line\n5aabc  /ok.txt\n', '/ok.txt': 'abc' },
      { warn: true },
    )
    expect(out).toBe('/ok.txt: OK\n')
    expect(err).toBe(
      'md5sum: /sums.txt: 1: improperly formatted MD5 checksum line\n' +
        'md5sum: WARNING: 1 line is improperly formatted\n',
    )
    expect(code).toBe(0)
  })
})
