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
    resourcePath: stripSlash(path),
    virtual: path,
    directory: path,
    resolved: true,
  })
}

function opts(
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
): CommandOpts {
  return { stdin, flags, filetypeFns: null, cwd: '/', resource: {} } as CommandOpts
}

function makeStream(files: Record<string, string>) {
  return function stream(p: PathSpec): AsyncIterable<Uint8Array> {
    const content = files[p.virtual]
    async function* gen(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      if (content === undefined) throw new Error(`${p.virtual}: no such file`)
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
  const [stdout, io] = await awkGeneric(paths, texts, o, makeStream(files))
  return [DEC.decode(await materialize(stdout)), io]
}

describe('awkGeneric', () => {
  it('prints a field from stdin', async () => {
    const [out] = await run([], ['{print $1}'], opts({}, ENC.encode('alpha beta\ngamma delta\n')))
    expect(out).toBe('alpha\ngamma\n')
  })

  it('splits on -F separator', async () => {
    const [out] = await run([], ['{print $2}'], opts({ F: ',' }, ENC.encode('a,b,c\nd,e,f\n')))
    expect(out).toBe('b\ne\n')
  })

  it('collapses whitespace with the default FS', async () => {
    const [out] = await run([], ['{print $2}'], opts({}, ENC.encode('a   b\n\tx\t \ty\n')))
    expect(out).toBe('b\ny\n')
  })

  it('collapses whitespace with an explicit single-space FS', async () => {
    const [out] = await run([], ['{print $2}'], opts({ F: ' ' }, ENC.encode('a   b\n')))
    expect(out).toBe('b\n')
  })

  it('splits into characters with an empty FS', async () => {
    const [out] = await run([], ['{print $2}'], opts({ F: '' }, ENC.encode('abc\n')))
    expect(out).toBe('b\n')
  })

  it('applies a single -v assignment', async () => {
    const [out] = await run([], ['{print x}'], opts({ v: 'x=hello' }, ENC.encode('line\n')))
    expect(out).toBe('hello\n')
  })

  it('applies repeated -v assignments', async () => {
    const [out] = await run(
      [],
      ['{print a, b}'],
      opts({ v: ['a=1', 'b=2'] }, ENC.encode('line\n')),
    )
    expect(out).toBe('1 2\n')
  })

  it('keeps the full value when -v contains equals', async () => {
    const [out] = await run([], ['{print x}'], opts({ v: 'x=a=b' }, ENC.encode('line\n')))
    expect(out).toBe('a=b\n')
  })

  it('filters with a numeric comparison', async () => {
    const [out] = await run([], ['$1 > 2 {print $1}'], opts({}, ENC.encode('1\n2\n3\n4\n')))
    expect(out).toBe('3\n4\n')
  })

  it('filters with a regex condition', async () => {
    const [out] = await run(
      [],
      ['/foo/ {print $0}'],
      opts({}, ENC.encode('foo bar\nbaz\nfoobar\n')),
    )
    expect(out).toBe('foo bar\nfoobar\n')
  })

  it('accumulates into END print', async () => {
    const [out] = await run(
      [],
      ['{sum += $1} END {print sum}'],
      opts({}, ENC.encode('10\n20\n30\n')),
    )
    expect(out).toBe('60\n')
  })

  it('coerces non-numeric accumulator operands like GNU awk', async () => {
    const [out] = await run(
      [],
      ['{sum += $1} END {print sum}'],
      opts({}, ENC.encode('3\nabc\n2.5x\n')),
    )
    expect(out).toBe('5.5\n')
  })

  it('reads from a file and caches it', async () => {
    const files = { '/data.txt': 'hello world\n' }
    const [out, io] = await run([spec('/data.txt')], ['{print $2}'], opts(), files)
    expect(out).toBe('world\n')
    expect(io.cache).toEqual(['/data.txt'])
  })

  it('processes all files with continuous NR and caches each', async () => {
    const files = { '/a.txt': 'one\ntwo\n', '/b.txt': 'three\n' }
    const [out, io] = await run(
      [spec('/a.txt'), spec('/b.txt')],
      ['{print NR, $1}'],
      opts(),
      files,
    )
    expect(out).toBe('1 one\n2 two\n3 three\n')
    expect(io.cache).toEqual(['/a.txt', '/b.txt'])
  })

  it('keeps lines separate when a file lacks a trailing newline', async () => {
    const files = { '/a.txt': 'one', '/b.txt': 'two\n' }
    const [out] = await run([spec('/a.txt'), spec('/b.txt')], ['{print NR, $1}'], opts(), files)
    expect(out).toBe('1 one\n2 two\n')
  })

  it('runs the -f program file over data paths', async () => {
    const files = { '/prog.awk': '{print $1}\n', '/data.txt': 'alpha beta\n' }
    const [out] = await run([spec('/data.txt')], [], opts({ f: '/prog.awk' }), files)
    expect(out).toBe('alpha\n')
  })

  it('emits blank lines for print of an empty string', async () => {
    const [out] = await run([], ['{print ""}'], opts({}, ENC.encode('one\ntwo\n')))
    expect(out).toBe('\n\n')
  })

  it('emits nothing for an action without print', async () => {
    const [out] = await run([], ['{x += 1}'], opts({}, ENC.encode('one\ntwo\n')))
    expect(out).toBe('')
  })

  it('prints a literal closing brace', async () => {
    const [out] = await run([], ['{print "}"}'], opts({}, ENC.encode('line\n')))
    expect(out).toBe('}\n')
  })

  it('returns exit 2 when no program is given', async () => {
    const [stdout, io] = await awkGeneric([], [], opts(), makeStream({}))
    expect(stdout).toBeNull()
    expect(io.exitCode).toBe(2)
    expect(DEC.decode(io.stderr)).toContain('usage')
  })

  it('returns exit 2 when the -f program file is unreadable', async () => {
    const [stdout, io] = await awkGeneric(
      [spec('/data.txt')],
      [],
      opts({ f: '/missing.awk' }),
      makeStream({ '/data.txt': 'x\n' }),
    )
    expect(stdout).toBeNull()
    expect(io.exitCode).toBe(2)
  })
})
