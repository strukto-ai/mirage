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
  flags: Record<string, string | boolean | number | string[]> = {},
  stdin: Uint8Array | null = null,
): CommandOpts {
  return { stdin, flags, filetypeFns: null, cwd: '/', resource: {} } as CommandOpts
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
    const [out] = await run([], ['{print a, b}'], opts({ v: ['a=1', 'b=2'] }, ENC.encode('line\n')))
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
    const [out, io] = await run([spec('/a.txt'), spec('/b.txt')], ['{print NR, $1}'], opts(), files)
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
    const result = await awkGeneric([], [], opts(), makeStream({}))
    const [stdout, io] = result ?? [null, new IOResult()]
    expect(stdout).toBeNull()
    expect(io.exitCode).toBe(2)
    expect(DEC.decode(await materialize(io.stderr))).toContain('usage')
  })

  it('returns exit 2 when the -f program file is unreadable', async () => {
    const result = await awkGeneric(
      [spec('/data.txt')],
      [],
      opts({ f: '/missing.awk' }),
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
      awkGeneric([spec('/data.txt')], [], opts({ f: '/prog.awk' }), stream),
    ).rejects.toThrow('403 Forbidden')
  })

  it('resolves a relative -f program file against the cwd', async () => {
    const files = { '/data/prog.awk': '{print $1}\n', '/data/in.txt': 'hey there\n' }
    const o = { ...opts({ f: 'prog.awk' }), cwd: '/data' } as CommandOpts
    const result = await awkGeneric([spec('/data/in.txt')], [], o, makeStream(files))
    const [stdout] = result ?? [null, new IOResult()]
    expect(DEC.decode(await materialize(stdout))).toBe('hey\n')
  })

  it('runs the -f program over multiple data files with continuous NR', async () => {
    const files = { '/prog.awk': '{print NR, $1}\n', '/a.txt': 'one\n', '/b.txt': 'two\n' }
    const [out, io] = await run(
      [spec('/a.txt'), spec('/b.txt')],
      [],
      opts({ f: '/prog.awk' }),
      files,
    )
    expect(out).toBe('1 one\n2 two\n')
    expect(io.cache).toEqual(['/a.txt', '/b.txt'])
  })

  it('concatenates repeated -f program files', async () => {
    const files = {
      '/p1.awk': '{sum += $1}\n',
      '/p2.awk': 'END {print sum}\n',
      '/nums.txt': '1\n2\n3\n',
    }
    const [out] = await run([spec('/nums.txt')], [], opts({ f: ['/p1.awk', '/p2.awk'] }), files)
    expect(out).toBe('6\n')
  })

  it('resolves -v variables in BEGIN and END blocks', async () => {
    const [out] = await run(
      [],
      ['BEGIN {print x} END {print x}'],
      opts({ v: 'x=hi' }, ENC.encode('line\n')),
    )
    expect(out).toBe('hi\nhi\n')
  })

  it('lets the last duplicate -v assignment win', async () => {
    const [out] = await run(
      [],
      ['{print x}'],
      opts({ v: ['x=first', 'x=second'] }, ENC.encode('line\n')),
    )
    expect(out).toBe('second\n')
  })

  it('emits a blank line for a bare print in BEGIN', async () => {
    const [out] = await run([], ['BEGIN {print} {print $1}'], opts({}, ENC.encode('a\n')))
    expect(out).toBe('\na\n')
  })

  it('prints a literal closing brace behind a condition', async () => {
    const [out] = await run([], ['/x/ {print "}"}'], opts({}, ENC.encode('x\ny\n')))
    expect(out).toBe('}\n')
  })
})

describe('awk unsupported constructs fail loud', () => {
  it('rejects an arithmetic assignment', async () => {
    await expect(run([], ['{x = y + 1; print x}'], opts({}, ENC.encode('line\n')))).rejects.toThrow(
      'unsupported construct',
    )
  })

  it('rejects a function call in print', async () => {
    await expect(run([], ['{print toupper($1)}'], opts({}, ENC.encode('line\n')))).rejects.toThrow(
      "unsupported construct: 'print toupper($1)'",
    )
  })

  it('rejects printf', async () => {
    await expect(run([], ['{printf "%s\\n", $1}'], opts({}, ENC.encode('line\n')))).rejects.toThrow(
      'unsupported construct',
    )
  })

  it('rejects an if statement', async () => {
    await expect(run([], ['{if ($1) print $1}'], opts({}, ENC.encode('line\n')))).rejects.toThrow(
      'unsupported construct',
    )
  })

  it('rejects an unsupported match operand', async () => {
    await expect(run([], ['length($1) ~ /1/'], opts({}, ENC.encode('a\n')))).rejects.toThrow(
      'unsupported construct',
    )
  })

  it('rejects arithmetic in a condition', async () => {
    await expect(run([], ['NR % 2 == 0 {print}'], opts({}, ENC.encode('a\nb\n')))).rejects.toThrow(
      'unsupported construct',
    )
  })
})

const FIELDS = 'alice 30 engineer\nbob 25 designer\ncarol 40 manager\n'

async function runStdin(
  program: string,
  stdin: string,
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<string> {
  const [out] = await run([], [program], opts(flags, ENC.encode(stdin)))
  return out
}

describe('awk regex match', () => {
  it('matches a field against a regex (issue #1065)', async () => {
    const out = await runStdin(
      '$4 ~ /[Aa]pplication/ {print}',
      'a|b|c|Application\nx|y|z|Other\n',
      {
        F: '|',
      },
    )
    expect(out).toBe('a|b|c|Application\n')
  })

  it('reads a boolean operator inside a regex as regex text', async () => {
    // awk 20200816 and mawk 1.3.4 both print the line: the `&&` belongs to
    // the regex, it is not a conjunction.
    expect(await runStdin('$0 ~ /A&&B/ {print}', 'xA&&By\nAB\n')).toBe('xA&&By\n')
  })

  it('reads a boolean operator inside a string as string text', async () => {
    expect(await runStdin('$1 == "a||b" {print $2}', 'a||b q\nz 1\n')).toBe('q\n')
  })

  it('matches a bare regex pattern holding an operator', async () => {
    expect(await runStdin('/A&&B/', 'xA&&By\nAB\n')).toBe('xA&&By\n')
  })

  it('negates the match with !~', async () => {
    expect(await runStdin('$3 !~ /^d/ {print $1}', FIELDS)).toBe('alice\ncarol\n')
  })

  it('reads a string right-hand side as a dynamic regex', async () => {
    expect(await runStdin('$2 ~ "0" && $1 ~ /^c/', FIELDS)).toBe('carol 40 manager\n')
  })

  it('reads a variable right-hand side as a dynamic regex', async () => {
    expect(await runStdin('$1 ~ pat {print $2}', FIELDS, { v: 'pat=ar' })).toBe('40\n')
  })

  it('matches a numeric right-hand side as text', async () => {
    expect(await runStdin('$1 ~ 1', '12\n3\n')).toBe('12\n')
  })

  it('accepts $NF and a builtin on the left', async () => {
    expect(await runStdin('$NF ~ /^App/', 'x y Application\nx y Other\n')).toBe('x y Application\n')
    expect(await runStdin('NR ~ /[13]/', 'a\nb\nc\n')).toBe('a\nc\n')
  })

  it('keeps a comparison operator inside the regex', async () => {
    expect(await runStdin('$0 ~ /a<b/', 'a<b\nab\n')).toBe('a<b\n')
    expect(await runStdin('$0 ~ /a==b/', 'a==b\nab\n')).toBe('a==b\n')
  })

  it('keeps a comparison operator inside a bare regex', async () => {
    expect(await runStdin('/a<b/', 'a<b\nab\n')).toBe('a<b\n')
  })

  it('keeps an escaped slash inside the regex', async () => {
    expect(await runStdin('$1 ~ /a\\/b/', 'a/b\nab\n')).toBe('a/b\n')
  })

  it('does not read an interval brace as the action brace', async () => {
    expect(await runStdin('$1 ~ /a{2}/ {print $2}', 'aa 1\na 2\n')).toBe('1\n')
  })

  it('needs no spaces around the operator', async () => {
    expect(await runStdin('$1~/a/', 'a b\nc d\n')).toBe('a b\n')
  })

  it('negates a bare regex', async () => {
    expect(await runStdin('!/bob/ {print $1}', FIELDS)).toBe('alice\ncarol\n')
  })

  it('negates an operand by its truthiness', async () => {
    expect(await runStdin('!$1', '0\n1\nfoo\n\n')).toBe('0\n\n')
    expect(await runStdin('!x', 'a\nb\n', { v: 'x=0' })).toBe('a\nb\n')
  })

  it('refuses an invalid regex with awk wording', async () => {
    await expect(runStdin('$1 ~ /(a/ {print}', 'a\n')).rejects.toThrow(
      'awk: syntax error in regular expression (a at source line 1',
    )
    await expect(runStdin('/(a/', 'a\n')).rejects.toThrow('syntax error in regular expression')
  })
})

describe('awk assignments and OFS', () => {
  it('executes a simple assignment', async () => {
    const [out] = await run([], ['{x = 1; print x}'], opts({}, ENC.encode('line\n')))
    expect(out).toBe('1\n')
  })

  it('assigns from a field', async () => {
    const [out] = await run([], ['{x = $2; print x}'], opts({}, ENC.encode('a b\n')))
    expect(out).toBe('b\n')
  })

  it('joins print arguments with OFS', async () => {
    const [out] = await run(
      [],
      ['BEGIN{OFS=":"} {print $1, $2}'],
      opts({}, ENC.encode('name age\nalice 30\n')),
    )
    expect(out).toBe('name:age\nalice:30\n')
  })
})

describe('awk compound statements', () => {
  const INPUT = ENC.encode('Welcome to x\nInstall it\n')

  it.each([
    ['{{print $1}}', 'Welcome\nInstall\n'],
    ['{{{print $1}}}', 'Welcome\nInstall\n'],
    ['{{print $1}; print $2}', 'Welcome\nto\nInstall\nit\n'],
    ['{print $1;{print $2}}', 'Welcome\nto\nInstall\nit\n'],
  ])('runs the body of %s', async (program, expected) => {
    const [out] = await run([], [program], opts({}, INPUT))
    expect(out).toBe(expected)
  })

  it('does not split on a semicolon inside a string', async () => {
    const [out] = await run([], ['{print "a;b", $1}'], opts({}, ENC.encode('x\n')))
    expect(out).toBe('a;b x\n')
  })
})

describe('awk unset values', () => {
  it('prints empty for an unset variable', async () => {
    const [out] = await run([], ['{print foo}'], opts({}, ENC.encode('line\n')))
    expect(out).toBe('\n')
  })

  it('prints empty for an out-of-range field', async () => {
    const [out] = await run([], ['{print $5}'], opts({}, ENC.encode('one two\n')))
    expect(out).toBe('\n')
  })
})
