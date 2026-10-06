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

import { awkGeneric } from './awk.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function spec(path: string): PathSpec {
  return new PathSpec({
    vfsPath: stripSlash(path),
    virtual: path,
    directory: path,
    resolved: true,
  })
}

function opts(flags: CommandOpts['flags'] = {}, stdin: Uint8Array | null = null): CommandOpts {
  return { stdin, flags, filetypeFns: null, cwd: '/', vfs: {} } as CommandOpts
}

function makeStream(files: Record<string, string>) {
  return function stream(p: PathSpec): AsyncIterable<Uint8Array> {
    const content = files[p.virtual]
    async function* gen(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      if (content === undefined) {
        // Stamped like a real backend's ENOENT; awk rethrows anything else.
        const err = new Error(p.virtual) as Error & { code: string }
        err.code = 'ENOENT'
        throw err
      }
      yield ENC.encode(content)
    }
    return gen()
  }
}

async function run(
  paths: PathSpec[],
  texts: string[],
  o: CommandOpts,
  files: Record<string, string> = {},
): Promise<[string, IOResult]> {
  const result = await awkGeneric(paths, texts, o, makeStream(files))
  const [stdout, io] = result ?? [null, new IOResult()]
  return [DEC.decode(await materialize(stdout)), io]
}

describe('awkGeneric', () => {
  it('splits into characters with an empty FS', async () => {
    const [out] = await run([], ['{print $2}'], opts({ F: '' }, ENC.encode('abc\n')))
    expect(out).toBe('b\n')
  })

  it('processes all files with continuous NR', async () => {
    const files = { '/a.txt': 'one\ntwo\n', '/b.txt': 'three\n' }
    const [out] = await run([spec('/a.txt'), spec('/b.txt')], ['{print NR, $1}'], opts(), files)
    expect(out).toBe('1 one\n2 two\n3 three\n')
  })

  it.each<[string | string[], Record<string, string>, string[], string]>([
    [
      '/prog.awk',
      { '/prog.awk': '{print $1}\n', '/data.txt': 'alpha beta\n' },
      ['/data.txt'],
      'alpha\n',
    ],
    [
      '/prog.awk',
      { '/prog.awk': '{print NR, $1}\n', '/a.txt': 'one\n', '/b.txt': 'two\n' },
      ['/a.txt', '/b.txt'],
      '1 one\n2 two\n',
    ],
    [
      ['/p1.awk', '/p2.awk'],
      { '/p1.awk': '{sum += $1}\n', '/p2.awk': 'END {print sum}\n', '/nums.txt': '1\n2\n3\n' },
      ['/nums.txt'],
      '6\n',
    ],
  ])('runs the -f program %j over the data paths', async (f, files, data, expected) => {
    const [out] = await run(
      data.map(spec),
      [],
      opts({ f: (Array.isArray(f) ? f : [f]).map(spec) }),
      files,
    )
    expect(out).toBe(expected)
  })

  it('returns exit 2 when the -f program file is unreadable', async () => {
    const result = await awkGeneric(
      [spec('/data.txt')],
      [],
      opts({ f: spec('/missing.awk') }),
      makeStream({ '/data.txt': 'x\n' }),
    )
    const [stdout, io] = result ?? [null, new IOResult()]
    expect(stdout).toBeNull()
    expect(io.exitCode).toBe(2)
    expect(DEC.decode(await materialize(io.stderr))).toBe(
      'awk: /missing.awk: No such file or directory\n',
    )
  })

  it('propagates a -f read failure that is not absence', async () => {
    const raw = new Error('S3 GET prog.awk failed: 403 Forbidden')
    function stream(): AsyncIterable<Uint8Array> {
      throw raw
    }
    await expect(
      awkGeneric([spec('/data.txt')], [], opts({ f: spec('/prog.awk') }), stream),
    ).rejects.toThrow('403 Forbidden')
  })

  it('resolves a relative -f program file against the cwd', async () => {
    const files = { '/data/prog.awk': '{print $1}\n', '/data/in.txt': 'hey there\n' }
    const o = {
      ...opts({ f: PathSpec.fromStrPath('prog.awk', undefined, '/data') }),
      cwd: '/data',
    } as CommandOpts
    const result = await awkGeneric([spec('/data/in.txt')], [], o, makeStream(files))
    const [stdout] = result ?? [null, new IOResult()]
    expect(DEC.decode(await materialize(stdout))).toBe('hey\n')
  })
})

async function runIo(program: string, stdin: string): Promise<[string, number, string]> {
  const [out, io] = await run([], [program], opts({}, ENC.encode(stdin)))
  return [out, io.exitCode, DEC.decode(await materialize(io.stderr))]
}

describe('awk fatal paths', () => {
  it.each([
    ['{print > "out.txt"}', 'awk: file output requires a workspace\n'],
    ['{system("ls")}', 'awk: running a command requires a workspace\n'],
    ['{"ls" | getline}', 'awk: running a command requires a workspace\n'],
    ['{print | "cat"}', 'awk: running a command requires a workspace\n'],
  ])('refuses %j', async (program, message) => {
    expect(await runIo(program, 'a\n')).toEqual(['', 2, message])
  })
})

async function runStdin(
  program: string,
  stdin: string,
  flags: CommandOpts['flags'] = {},
): Promise<string> {
  const [out] = await run([], [program], opts(flags, ENC.encode(stdin)))
  return out
}

describe('awk runs a program on stdin', () => {
  it.each([
    ['{print $2}', 'a   b\n\tx\t \ty\n', 'b\ny\n'],
    ['$1 ~ /a{2}/ {print $2}', 'aa 1\na 2\n', '1\n'],
  ])('runs %j', async (program, stdin, expected) => {
    expect(await runStdin(program, stdin)).toBe(expected)
  })
})

async function* chunked(parts: readonly (string | Uint8Array)[]): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    await Promise.resolve()
    yield typeof part === 'string' ? ENC.encode(part) : part
  }
}

describe('awk RS', () => {
  it.each<[(string | Uint8Array)[], string, string]>([
    [['a\n', '\nb\n'], '', 'a|b|'],
    [['a1', '2b'], '[0-9]+', 'a|b|'],
    [['a:', 'b'], ':', 'a|b|'],
    [[Uint8Array.of(0x68, 0xc3), Uint8Array.of(0xa9, 0x3a, 0x78)], ':', 'h\u00e9|x|'],
  ])('holds a record across the chunks %j', async (parts, rs, expected) => {
    const o = { ...opts({ v: [`RS=${rs}`] }), stdin: chunked(parts) }
    const [out] = await run([], ['{printf "%s|", $0}'], o)
    expect(out).toBe(expected)
  })

  it('takes the whole newline run as the paragraph separator', async () => {
    const o = { ...opts({ v: ['RS='] }), stdin: chunked(['a\n\n', '\nb\n']) }
    const [out] = await run([], ['{printf "%s|", $0; RS="\\n"}'], o)
    expect(out).toBe('a|b|')
  })
})
