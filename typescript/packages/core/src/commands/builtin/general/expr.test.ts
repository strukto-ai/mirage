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

import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { OpsRegistry } from '../../../ops/registry.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { GENERAL_EXPR, isNull } from './expr.ts'
import { translateBre } from '../utils/bre.ts'

const DEC = new TextDecoder()

async function runExpr(texts: string[]): Promise<{ out: string; err: string; exitCode: number }> {
  const resource = new RAMResource()
  const cmd = GENERAL_EXPR[0]
  if (cmd === undefined) throw new Error('expr not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags: {},
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { out: '', err: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), err: await ioResult.stderrStr(), exitCode: ioResult.exitCode }
}

// Every row below is a measured GNU coreutils 9.4 answer, `LC_ALL=C`.
async function expectValue(texts: string[], out: string, exitCode: number): Promise<void> {
  expect({ texts, ...(await runExpr(texts)) }).toEqual({
    texts,
    out: out + '\n',
    err: '',
    exitCode,
  })
}

async function expectRefusal(texts: string[], err: string): Promise<void> {
  expect({ texts, ...(await runExpr(texts)) }).toEqual({
    texts,
    out: '',
    err: err + '\n',
    exitCode: 2,
  })
}

// The same run, answering stdout as a byte view: one character per byte,
// so a row can name the exact bytes GNU wrote without a TextDecoder
// turning an invalid one into U+FFFD.
async function runExprByteView(texts: string[]): Promise<{ out: string; exitCode: number }> {
  const resource = new RAMResource()
  const cmd = GENERAL_EXPR[0]
  if (cmd === undefined) throw new Error('expr not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags: {},
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) throw new Error('expr answered nothing')
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  let view = ''
  for (const byte of buf) view += String.fromCharCode(byte)
  return { out: view, exitCode: ioResult.exitCode }
}

const NON_INTEGER = 'expr: non-integer argument'
const DIVISION_BY_ZERO = 'expr: division by zero'

// An operand past every float's range, which is where a float64 read
// stopped seeing the word as a number at all and started comparing the
// two sides as strings. The mirrored rows are in test_expr.py.
const BEYOND_FLOAT = '1' + '0'.repeat(320)

describe('expr arithmetic', () => {
  it('adds, subtracts, multiplies, divides and takes a remainder', async () => {
    await expectValue(['2', '+', '3'], '5', 0)
    await expectValue(['10', '-', '4'], '6', 0)
    await expectValue(['6', '*', '7'], '42', 0)
    await expectValue(['20', '/', '3'], '6', 0)
    await expectValue(['10', '%', '3'], '1', 0)
    await expectValue(['5', '%', '3'], '2', 0)
  })

  it('division truncates toward zero, it does not floor', async () => {
    await expectValue(['-10', '/', '3'], '-3', 0)
    await expectValue(['10', '/', '-3'], '-3', 0)
    await expectValue(['-10', '/', '-10'], '1', 0)
  })

  it('a remainder takes the dividend sign and ignores the divisor', async () => {
    await expectValue(['-10', '%', '3'], '-1', 0)
    await expectValue(['10', '%', '-3'], '1', 0)
  })

  it('a zero divisor is exit 2 with empty stdout, for / and % alike', async () => {
    await expectRefusal(['1', '/', '0'], DIVISION_BY_ZERO)
    await expectRefusal(['1', '%', '0'], DIVISION_BY_ZERO)
  })

  it('a zero value exits 1, which is a success and not an error', async () => {
    await expectValue(['2', '-', '2'], '0', 1)
    await expectValue(['-1', '/', '2'], '0', 1)
    await expectValue(['1', '/', '-2'], '0', 1)
  })

  it('refuses every operand shape outside GNU -?[0-9]+', async () => {
    for (const operand of ['+5', ' 5 ', ' 5', '5 ', '1_0', '0x10', '1e3', 'abc', '1.5']) {
      await expectRefusal([operand, '+', '1'], NON_INTEGER)
    }
    await expectRefusal(['1', '*', 'abc'], NON_INTEGER)
  })

  it('reads a leading zero as decimal, and -0 / 00 as zero', async () => {
    await expectValue(['05', '+', '1'], '6', 0)
    await expectValue(['-0', '+', '1'], '1', 0)
    await expectValue(['00', '+', '1'], '1', 0)
  })

  it('is arbitrary precision, as GNU is', async () => {
    await expectValue(['9223372036854775807', '+', '1'], '9223372036854775808', 0)
    await expectValue(['2', '*', '99999999999999999999'], '199999999999999999998', 0)
    await expectValue(['9007199254740993', '=', '9007199254740992'], '0', 1)
  })

  it('compares an operand past every float as a number', async () => {
    // The decisive rows: a float64 read answered these upside down,
    // because `Infinity` is not an integer operand and the comparison
    // quietly became a byte-order string compare.
    await expectValue(['2', '<', BEYOND_FLOAT], '1', 0)
    await expectValue(['2', '>', BEYOND_FLOAT], '0', 1)
    await expectValue([BEYOND_FLOAT, '>', '2'], '1', 0)
    await expectValue(['-' + BEYOND_FLOAT, '<', '2'], '1', 0)
  })

  it('does arithmetic on an operand past every float', async () => {
    await expectValue([BEYOND_FLOAT, '+', '0'], BEYOND_FLOAT, 0)
    await expectValue([BEYOND_FLOAT, '%', '7'], '2', 0)
  })

  it('never prints exponential notation', async () => {
    // `expr` cannot print `1e+24`, and could not read it back as an
    // operand either, so a product this size has to render in full.
    await expectValue(['1000000000000', '*', '1000000000000'], '1' + '0'.repeat(24), 0)
    await expectValue(['999999999999999999999', '+', '1'], '1' + '0'.repeat(21), 0)
    await expectValue(['2147483647', '*', '2147483647'], '4611686014132420609', 0)
  })

  it('clamps a substr length past every float', async () => {
    await expectValue(['substr', 'abcde', '1', BEYOND_FLOAT], 'abcde', 0)
    await expectValue(['substr', 'abcde', BEYOND_FLOAT, '1'], '', 1)
  })

  it('is arbitrary precision past the python twin`s conversion cap', async () => {
    // CPython caps a base-10 int/str conversion at 4300 digits and the
    // twin chunks around it; a `bigint` has no cap, so these rows exist to
    // pin that the two hosts answer alike. Mirrored in test_expr.py.
    const over = '1' + '0'.repeat(4300)
    await expectValue([over, '+', '0'], over, 0)
    await expectValue(['2', '<', '1' + '0'.repeat(8000)], '1', 0)
    await expectValue(['-' + '9'.repeat(4301), '<', '2'], '1', 0)
    await expectValue([over, '%', '7'], '4', 0)
    await expectValue(['1' + '0'.repeat(8000), '%', '7'], '2', 0)
  })

  it('renders a result wider than that cap in full', async () => {
    // The product is 4400 digits, over the cap even though neither
    // operand is, so the twin has to chunk the OUTPUT side too.
    const nines = '9'.repeat(2200)
    const { out, exitCode } = await runExpr([nines, '*', nines])
    expect([out.length, exitCode]).toEqual([4401, 0])
    expect(out.endsWith('1\n')).toBe(true)
  })

  it('refuses an operand with a trailing newline', async () => {
    // JavaScript's `$` is already end-of-input; python's is not, which
    // is why its twin reads the grammar with `fullmatch`.
    await expectRefusal(['12\n', '+', '1'], NON_INTEGER)
    await expectValue(['12\n', '=', '12'], '0', 1)
    await expectValue(['substr', 'abcde', '2\n', '1'], '', 1)
  })
})

describe('expr precedence and associativity', () => {
  it('binds * / % tighter than + -', async () => {
    await expectValue(['2', '+', '3', '*', '4'], '14', 0)
    await expectValue(['2', '*', '3', '+', '4'], '10', 0)
    await expectValue(['2', '+', '10', '%', '4'], '4', 0)
  })

  it('is left-associative at every level', async () => {
    await expectValue(['10', '-', '2', '-', '3'], '5', 0)
    await expectValue(['100', '/', '10', '/', '2'], '5', 0)
    await expectValue(['2', '*', '3', '*', '4'], '24', 0)
    await expectValue(['10', '%', '4', '*', '2'], '4', 0)
    await expectValue(['2', '*', '10', '%', '4'], '0', 1)
    await expectValue(['1', '<', '2', '=', '1'], '1', 0)
    await expectValue(['10', '<', '9', '<', '8'], '1', 0)
  })

  it('binds + - tighter than the comparisons', async () => {
    await expectValue(['1', '+', '2', '=', '3'], '1', 0)
  })

  it('binds the comparisons tighter than &, and & tighter than |', async () => {
    await expectValue(['1', '&', '1', '=', '2'], '0', 1)
    await expectValue(['1', '|', '0', '=', '0'], '1', 0)
    await expectValue(['2', '|', '0', '&', '0'], '2', 0)
  })

  it('binds : tighter than any arithmetic, and left-associatively', async () => {
    await expectValue(['1', '+', 'abc', ':', 'a'], '2', 0)
    await expectValue(['abc', ':', 'a', '+', '1'], '2', 0)
    await expectValue(['abc', ':', 'a', ':', '1'], '1', 0)
  })

  it('has no unary operator: -5 is an integer literal', async () => {
    await expectValue(['-5', '+', '3'], '-2', 0)
    await expectValue(['3', '-', '-5'], '8', 0)
  })

  it('does not know ^, <> or !', async () => {
    await expectRefusal(['2', '^', '3'], "expr: syntax error: unexpected argument '^'")
    await expectRefusal(['1', '<>', '2'], "expr: syntax error: unexpected argument '<>'")
    // `!` is not an operator, so it becomes a string operand and `0` is
    // the word with no slot left.
    await expectRefusal(['!', '0'], "expr: syntax error: unexpected argument '0'")
  })
})

describe('expr | and &', () => {
  it('| answers the right operand when the left is empty or zero', async () => {
    await expectValue(['0', '|', '3'], '3', 0)
    await expectValue(['', '|', '7'], '7', 0)
  })

  it('& answers the left operand when both are truthy, else zero', async () => {
    await expectValue(['2', '&', '3'], '2', 0)
    await expectValue(['0', '&', '3'], '0', 1)
  })

  it('both short-circuit, so a dead division by zero never runs', async () => {
    await expectValue(['1', '|', '1', '/', '0'], '1', 0)
    await expectValue(['0', '&', '1', '/', '0'], '0', 1)
  })

  it('counts any run of zeros as false, not just the character zero', () => {
    expect([isNull(''), isNull('0'), isNull('00'), isNull('-0'), isNull('-000')]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ])
    expect([isNull('-'), isNull('1'), isNull('0a'), isNull('00 ')]).toEqual([
      false,
      false,
      false,
      false,
    ])
  })
})

describe('expr parentheses', () => {
  it('groups an expression, and nests', async () => {
    await expectValue(['(', '2', '+', '3', ')', '*', '4'], '20', 0)
    await expectValue(['(', '(', '1', '+', '2', ')', ')'], '3', 0)
    await expectValue(['(', 'abc', ')', ':', 'a'], '1', 0)
    await expectValue(['length', '(', 'abc', ')'], '3', 0)
    await expectValue(['(', 'length', 'abcde', ')', '*', '2'], '10', 0)
    await expectValue(['(', '+', '1', ')', '+', '2'], '3', 0)
  })

  it('refuses nesting past our own limit, which GNU does not declare', async () => {
    const deep = (levels: number): string[] => [
      ...Array<string>(levels).fill('('),
      '1',
      ...Array<string>(levels).fill(')'),
    ]
    await expectValue(deep(64), '1', 0)
    await expectRefusal(deep(65), 'expr: expression nesting too deep (limit 64)')
  })
})

describe('expr + TOKEN', () => {
  it('quotes exactly one following word, whatever it spells', async () => {
    await expectValue(['+', 'hello'], 'hello', 0)
    await expectValue(['+', '+'], '+', 0)
    await expectValue(['+', '1'], '1', 0)
    await expectValue(['+', 'length'], 'length', 0)
    await expectValue(['+', 'match'], 'match', 0)
    await expectValue(['+', '('], '(', 0)
    await expectValue(['+', ')'], ')', 0)
    await expectValue(['+', ''], '', 1)
    await expectValue(['+', '0'], '0', 1)
  })

  it('composes with the rest of the grammar', async () => {
    await expectValue(['1', '+', '+', '2'], '3', 0)
    await expectValue(['+', '2', '*', '3'], '6', 0)
    await expectValue(['2', '*', '+', '3'], '6', 0)
    await expectValue(['+', 'abc', ':', 'a'], '1', 0)
    await expectValue(['abc', ':', '+', 'a'], '1', 0)
    await expectValue(['length', '+', 'length'], '6', 0)
  })

  it('does not recurse, so a second operator or a spare word refuses', async () => {
    await expectRefusal(['+'], "expr: syntax error: missing argument after '+'")
    await expectRefusal(['+', '+', 'hello'], "expr: syntax error: unexpected argument 'hello'")
    await expectRefusal(['+', 'length', 'abcde'], "expr: syntax error: unexpected argument 'abcde'")
  })
})

describe('expr keyword operators', () => {
  it('length counts the characters', async () => {
    await expectValue(['length', 'abcde'], '5', 0)
    await expectValue(['length', ''], '0', 1)
  })

  it('substr is 1-based and clamps an over-long length', async () => {
    await expectValue(['substr', 'abcde', '2', '3'], 'bcd', 0)
    await expectValue(['substr', 'abcde', '2', '99'], 'bcde', 0)
  })

  it('substr answers the empty string rather than refusing', async () => {
    for (const [pos, len] of [
      ['0', '3'],
      ['9', '1'],
      ['1', '0'],
      ['-1', '3'],
      ['2', '-1'],
    ]) {
      await expectValue(['substr', 'abcde', pos ?? '', len ?? ''], '', 1)
    }
    await expectValue(['substr', 'abc', 'x', '1'], '', 1)
  })

  it('index is a character set search, not a substring search', async () => {
    await expectValue(['index', 'abcde', 'cd'], '3', 0)
    await expectValue(['index', 'abcde', 'ec'], '3', 0)
    await expectValue(['index', 'abcde', 'xyz'], '0', 1)
    await expectValue(['index', 'abcde', ''], '0', 1)
  })

  it('match is the prefix spelling of :', async () => {
    await expectValue(['match', 'abcdef', 'abc'], '3', 0)
    await expectValue(['match', 'abcdef', 'a\\(bc\\)'], 'bc', 0)
    await expectValue(['abcdef', ':', 'abc'], '3', 0)
    await expectValue(['abcdef', ':', 'a\\(bc\\)'], 'bc', 0)
  })

  it('answers a failed match with 0, or the empty string when grouped', async () => {
    await expectValue(['abc', ':', 'x'], '0', 1)
    await expectValue(['abc', ':', '\\(x\\)'], '', 1)
    await expectValue(['abc', ':', 'a\\(x\\)\\?'], '', 1)
  })

  it('names the last word seen when an operand is missing', async () => {
    await expectRefusal(['length'], "expr: syntax error: missing argument after 'length'")
    await expectRefusal(['substr', 'abc', '1'], "expr: syntax error: missing argument after '1'")
    await expectRefusal(['index', 'abc'], "expr: syntax error: missing argument after 'abc'")
    await expectRefusal(['match', 'abc'], "expr: syntax error: missing argument after 'abc'")
    await expectRefusal(
      ['substr', 'abc', '1', '2', '3'],
      "expr: syntax error: unexpected argument '3'",
    )
  })
})

describe('expr : is a POSIX BRE, not a JavaScript RegExp', () => {
  it('is implicitly anchored at the start of the subject', async () => {
    await expectValue(['abc', ':', 'b'], '0', 1)
    await expectValue(['abc', ':', 'a.c'], '3', 0)
    await expectValue(['abc', ':', '.*'], '3', 0)
    await expectValue(['abc', ':', '^abc$'], '3', 0)
  })

  it('reads \\+ and \\? as quantifiers and bare + ? as literals', async () => {
    await expectValue(['abc', ':', 'a\\+'], '1', 0)
    await expectValue(['aaa', ':', 'a\\+'], '3', 0)
    await expectValue(['a+b', ':', 'a+b'], '3', 0)
    await expectValue(['abc', ':', 'a\\?'], '1', 0)
    await expectValue(['a?', ':', 'a?'], '2', 0)
  })

  it('reads \\| as alternation and bare | as a literal', async () => {
    await expectValue(['abc', ':', 'a\\|b'], '1', 0)
    await expectValue(['abc', ':', 'a|b'], '0', 1)
    await expectValue(['a|b', ':', 'a|b'], '3', 0)
  })

  it('reads \\( \\) as the groups and returns group 1 only', async () => {
    await expectValue(['abc', ':', '\\(a\\)\\(b\\)'], 'a', 0)
  })

  it('reads \\{n\\} as the interval and bare {n} as a literal', async () => {
    await expectValue(['aab', ':', 'a\\{2\\}'], '2', 0)
    await expectValue(['abc', ':', 'a\\{2\\}'], '0', 1)
    await expectValue(['aab', ':', 'a{2}'], '0', 1)
    await expectValue(['a{2}', ':', 'a{2}'], '4', 0)
  })

  it('reads a leading * as a literal, where RegExp throws', async () => {
    await expectValue(['*a', ':', '*a'], '2', 0)
    await expectValue(['abc', ':', '*a'], '0', 1)
  })

  it('reads a mid-pattern ^ or $ as a literal', async () => {
    await expectValue(['abc', ':', 'a^b'], '0', 1)
    await expectValue(['a^b', ':', 'a^b'], '3', 0)
    await expectValue(['a$b', ':', 'a$b'], '3', 0)
  })

  it('supports POSIX classes, GNU \\w, and backreferences', async () => {
    await expectValue(['abc', ':', '[[:alpha:]]\\+'], '3', 0)
    await expectValue(['abc', ':', '\\w\\+'], '3', 0)
    await expectValue(['aab', ':', '\\(a\\)\\1'], 'a', 0)
    await expectValue(['abc', ':', '\\(a\\)\\1'], '', 1)
  })

  it('refuses an uncompilable pattern with glibc regerror wording', async () => {
    // These three strings are glibc's, printed verbatim under expr's own
    // prefix, which is why they read the way they do.
    await expectRefusal(['abc', ':', '\\('], 'expr: Unmatched ( or \\(')
    await expectRefusal(['abc', ':', '['], 'expr: Invalid regular expression')
    await expectRefusal(['abc', ':', 'a\\{1,'], 'expr: Unmatched \\{')
  })

  it('emits the inverted spellings the host engine needs', () => {
    expect(translateBre('a\\(bc\\)')).toEqual(['a(bc)', 1])
    expect(translateBre('a(bc)')).toEqual(['a\\(bc\\)', 0])
    expect(translateBre('a\\|b')).toEqual(['a|b', 0])
    expect(translateBre('a|b')).toEqual(['a\\|b', 0])
    expect(translateBre('a\\+')).toEqual(['a+', 0])
    expect(translateBre('a+')).toEqual(['a\\+', 0])
    expect(translateBre('a\\{2,3\\}')).toEqual(['a{2,3}', 0])
    expect(translateBre('a{2}')).toEqual(['a\\{2\\}', 0])
    expect(translateBre('*a')).toEqual(['\\*a', 0])
    expect(translateBre('[[:alpha:]]')).toEqual(['[A-Za-z]', 0])
    expect(translateBre('\\w')).toEqual(['[0-9A-Za-z_]', 0])
  })
})

describe('expr comparisons', () => {
  it('is numeric only when both sides are integers', async () => {
    await expectValue(['10', '>', '9'], '1', 0)
    await expectValue(['9', '<', '10'], '1', 0)
    await expectValue(['010', '=', '10'], '1', 0)
    await expectValue(['-0', '=', '0'], '1', 0)
  })

  it('falls back to a byte-order string compare, never to a refusal', async () => {
    await expectValue(['abc', '>', 'abd'], '0', 1)
    await expectValue(['10', '>', '9a'], '0', 1)
    await expectValue(['9a', '<', '10'], '0', 1)
    await expectValue([' 10', '=', '10'], '0', 1)
    await expectValue(['+1', '=', '1'], '0', 1)
    await expectValue(['+5', '=', '+5'], '1', 0)
    await expectValue(['', '=', ''], '1', 0)
    await expectValue(['1', '<', ''], '0', 1)
    await expectValue(['', '<', '1'], '1', 0)
    await expectValue(['abc', '<', 'ABC'], '0', 1)
  })

  it('reads == as an undocumented synonym for =', async () => {
    await expectValue(['1', '==', '1'], '1', 0)
    await expectValue(['1', '==', '2'], '0', 1)
    await expectValue(['abc', '==', 'abc'], '1', 0)
  })

  it('answers the remaining operators', async () => {
    await expectValue(['5', '>', '3'], '1', 0)
    await expectValue(['2', '=', '5'], '0', 1)
    await expectValue(['abc', '!=', 'xyz'], '1', 0)
    await expectValue(['1', '!=', '2'], '1', 0)
    await expectValue(['1', '<=', '1'], '1', 0)
    await expectValue(['1', '>=', '2'], '0', 1)
  })
})

describe('expr error wording', () => {
  it('reports zero expression words as a missing operand, with a hint', async () => {
    // The only diagnostic with a second line, and the only one that is
    // not a `syntax error`.
    expect(await runExpr([])).toEqual({
      out: '',
      err: "expr: missing operand\nTry 'expr --help' for more information.\n",
      exitCode: 2,
    })
  })

  it('names the operator when its right operand is missing', async () => {
    await expectRefusal(['1', '+'], "expr: syntax error: missing argument after '+'")
  })

  it('names a leftover word as an unexpected argument', async () => {
    await expectRefusal(['1', '2'], "expr: syntax error: unexpected argument '2'")
    await expectRefusal(['1', '2', '3'], "expr: syntax error: unexpected argument '2'")
    await expectRefusal(['1', '?', '2'], "expr: syntax error: unexpected argument '?'")
    await expectRefusal(['1', '+', '2', ')'], "expr: syntax error: unexpected argument ')'")
  })

  it('names the last word seen when a parenthesis is never closed', async () => {
    await expectRefusal(['(', '1', '+', '2'], "expr: syntax error: expecting ')' after '2'")
  })

  // GNU picks between two clauses for an unclosed parenthesis on one
  // fact: whether the line ran out (`after <last consumed>`) or a word is
  // standing where the `)` belonged (`instead of <that word>`). Every row
  // is a measured GNU coreutils 9.4 answer, mirrored in test_expr.py as
  // CLOSE_CLAUSES.
  it.each([
    // Ran out: `after`, naming the last word consumed.
    [['(', '1', '+', '2'], "expecting ')' after '2'"],
    [['(', '1'], "expecting ')' after '1'"],
    [['(', 'length', 'ab'], "expecting ')' after 'ab'"],
    // The last word consumed can itself be a `)`, from an inner group.
    [['(', '(', '1', ')'], "expecting ')' after ')'"],
    // A word stands there: `instead of`, naming that word and not the
    // one before it.
    [['(', '1', '1'], "expecting ')' instead of '1'"],
    [['(', '1', '2', ')'], "expecting ')' instead of '2'"],
    [['(', '1', '+', '2', '3'], "expecting ')' instead of '3'"],
    [['(', '1', '=', '2', 'x'], "expecting ')' instead of 'x'"],
    [['(', 'length', 'ab', 'y'], "expecting ')' instead of 'y'"],
    [['(', '\\|', '1'], "expecting ')' instead of '1'"],
    [['(', '(', '1', '2'], "expecting ')' instead of '2'"],
    [['(', '1', '', ')'], "expecting ')' instead of ''"],
    // An operator with nothing to its right still outranks the unclosed
    // parenthesis: the inner expression refuses first.
    [['(', '1', '+'], "missing argument after '+'"],
    [['(', '1', '|'], "missing argument after '|'"],
    [['(', '1', ':'], "missing argument after ':'"],
    [['(', 'substr', 'a', '1'], "missing argument after '1'"],
    // A complete group with a leftover `)` is the ordinary leftover
    // clause, not either of the two above.
    [['(', '1', ')', ')'], "unexpected argument ')'"],
  ] as [string[], string][])('%j -> %s', async (texts, detail) => {
    await expectRefusal(texts, `expr: syntax error: ${detail}`)
  })

  // GNU passes the word it names in a diagnostic through gnulib's
  // `quote()`, which in the C locale escapes a backslash, a single quote,
  // the seven named C escapes, and every other byte outside 0x20-0x7e as
  // three octal digits. The table is per BYTE, so a two-byte character is
  // two octal escapes. An operand is written as the shell hands it over,
  // so a raw byte is its U+DCxx sentinel.
  //
  // The helper itself is covered where it lives, in commands/quote.test.ts --
  // it is shared by nl, expand, shuf, cut and expr, and all five were
  // measured to agree byte for byte (NL3-A). What these rows add is that
  // expr reaches it through a real command line.
  it.each([
    [['1', 'a\\b'], "unexpected argument 'a\\\\b'"],
    [['1', 'a\\\\b'], "unexpected argument 'a\\\\\\\\b'"],
    [['1', '\\'], "unexpected argument '\\\\'"],
    [['1', "a'b"], "unexpected argument 'a\\'b'"],
    [['1', "'"], "unexpected argument '\\''"],
    [['1', "a\\'b"], "unexpected argument 'a\\\\\\'b'"],
    // The seven escapes gnulib spells by name rather than in octal.
    [['1', 'a\x07b'], "unexpected argument 'a\\ab'"],
    [['1', 'a\x08b'], "unexpected argument 'a\\bb'"],
    [['1', 'a\tb'], "unexpected argument 'a\\tb'"],
    [['1', 'a\nb'], "unexpected argument 'a\\nb'"],
    [['1', 'a\x0bb'], "unexpected argument 'a\\vb'"],
    [['1', 'a\fb'], "unexpected argument 'a\\fb'"],
    [['1', 'a\rb'], "unexpected argument 'a\\rb'"],
    // Everything else outside 0x20-0x7e is three octal digits, always
    // padded so a following digit cannot be read into the escape.
    [['1', 'a\x01b'], "unexpected argument 'a\\001b'"],
    [['1', 'a\x1fb'], "unexpected argument 'a\\037b'"],
    [['1', 'a\x7fb'], "unexpected argument 'a\\177b'"],
    [['1', 'a\udc80b'], "unexpected argument 'a\\200b'"],
    [['1', 'a\udcffb'], "unexpected argument 'a\\377b'"],
    [['1', '\x011'], "unexpected argument '\\0011'"],
    // A multibyte character is its bytes, one octal escape each.
    [['1', '\u00e9'], "unexpected argument '\\303\\251'"],
    [['1', '\u65e5'], "unexpected argument '\\346\\227\\245'"],
    // Printable ASCII passes through, including the ones a shell would
    // care about and the double quote gnulib leaves alone.
    [['1', 'a b'], "unexpected argument 'a b'"],
    [['1', 'a"b'], `unexpected argument 'a"b'`],
    [['1', 'a$b'], "unexpected argument 'a$b'"],
    [['1', 'a`b'], "unexpected argument 'a`b'"],
    [['1', '~^:!%*'], "unexpected argument '~^:!%*'"],
  ] as [string[], string][])('quote() %j', async (texts, detail) => {
    await expectRefusal(texts, `expr: syntax error: ${detail}`)
  })

  // The same rule reached through each of the four clauses that name a
  // word, since GNU quotes in all of them and a fix applied to only one
  // would pass a narrower test.
  it.each([
    [['1', 'a\\b'], "unexpected argument 'a\\\\b'"],
    [['substr', 'abc', 'a\\b'], "missing argument after 'a\\\\b'"],
    [['(', 'a\\b'], "expecting ')' after 'a\\\\b'"],
    [['(', '1', 'a\\b'], "expecting ')' instead of 'a\\\\b'"],
    [['(', '\u00e9'], "expecting ')' after '\\303\\251'"],
    [['(', 'a\tb'], "expecting ')' after 'a\\tb'"],
    [['(', ''], "expecting ')' after ''"],
  ] as [string[], string][])('quotes in every clause %j', async (texts, detail) => {
    await expectRefusal(texts, `expr: syntax error: ${detail}`)
  })

  it('drops the argument noun for a ) where a primary belongs', async () => {
    await expectRefusal(['(', ')'], "expr: syntax error: unexpected ')'")
  })

  it('keeps stdout at zero bytes on a single-word success', async () => {
    await expectValue(['1'], '1', 0)
  })
})

// Every row is a measured GNU coreutils 9.4 answer under `LC_ALL=C`,
// recorded in the round-8 (`EX2`) truth table. expr has no characters,
// only bytes: `length` counts them, `index` searches a set of them,
// `substr` will split one in half, and the BRE's `.` matches one.
//
// An operand is written as the shell hands it over, so a raw byte is its
// U+DCxx sentinel (`'a\udcffb'` is the three bytes `61 ff 62`); the
// answer is a byte view, one character per byte. The same rows are
// mirrored in test_expr.py as BYTE_SEMANTICS.
describe('expr string operators count bytes, not characters', () => {
  it.each([
    // `length` is a byte count, so a two-byte character counts twice and
    // a newline counts once.
    [['length', 'éé'], '4', 0],
    [['length', 'é'], '2', 0],
    [['length', '日本語'], '9', 0],
    [['length', 'a\udcffb'], '3', 0],
    [['length', '\udcff\udcfe'], '2', 0],
    [['length', '𐂀'], '4', 0],
    [['length', '12\n'], '3', 0],
    // `index` is `strcspn` over a set of BYTES, so a byte shared with a
    // different character matches: `a`-umlaut is `c3 a4` and `e`-acute is
    // `c3 a9`, and they share the leading `c3`.
    [['index', 'éé', 'é'], '1', 0],
    [['index', 'abcéde', 'é'], '4', 0],
    [['index', 'ä', 'é'], '1', 0],
    [['index', 'abä', 'é'], '3', 0],
    [['index', 'a\udcff', '\udcff'], '2', 0],
    [['index', 'éé', ''], '0', 1],
    // `substr` slices bytes, so it splits a character and prints the half
    // -- invalid UTF-8 on stdout, which is what GNU writes.
    [['substr', 'éé', '1', '1'], '\xc3', 0],
    [['substr', 'éé', '1', '2'], '\xc3\xa9', 0],
    [['substr', 'éé', '2', '2'], '\xa9\xc3', 0],
    [['substr', 'éé', '2', '1'], '\xa9', 0],
    [['substr', 'éé', '1', '3'], '\xc3\xa9\xc3', 0],
    [['substr', 'éé', '4', '1'], '\xa9', 0],
    [['substr', 'éé', '5', '1'], '', 1],
    [['substr', 'a\udcffb', '2', '1'], '\xff', 0],
    // The BRE runs over bytes too, so the match length is a byte count
    // and a group's text can be one byte of a character.
    [['éé', ':', '.*'], '4', 0],
    [['éé', ':', '.'], '1', 0],
    [['é', ':', '.'], '1', 0],
    [['é', ':', '..'], '2', 0],
    [['é', ':', '...'], '0', 1],
    [['é', ':', '\\(.\\)'], '\xc3', 0],
    [['éé', ':', '\\(..\\)'], '\xc3\xa9', 0],
    [['match', 'éé', '\\(..\\)'], '\xc3\xa9', 0],
    [['ééx', ':', '[^x]*'], '4', 0],
    // A multibyte pattern is a sequence of bytes, and an interval binds
    // to the last of them: the pattern is `c3` then two `a9`.
    [['éé', ':', 'é'], '2', 0],
    [['é', ':', '[é]'], '1', 0],
    [['a', ':', '[é]'], '0', 1],
    [['ééé', ':', 'é\\{2\\}'], '0', 1],
    // The C locale's classes are ASCII, so neither matches a byte above
    // 0x7f -- which is what bre.ts's inlined expansions already emit.
    [['é', ':', '[[:alpha:]]*'], '0', 1],
    [['é', ':', '\\w*'], '0', 1],
    [['a\udcffb', ':', 'a.b'], '3', 0],
    [['a\udcffb', ':', '.*'], '3', 0],
  ] as [string[], string, number][])('%j', async (texts, out, exitCode) => {
    expect(await runExprByteView(texts)).toEqual({ out: out + '\n', exitCode })
  })
})

describe('expr through the shell', () => {
  // The same lines the integ and conformance batteries type, so the
  // quoting an operator needs to reach expr intact is pinned here too.
  async function makeWs(): Promise<Workspace> {
    const parser = await getTestParser()
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    return new Workspace(
      { '/ram': ram },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
  }

  it.each([
    ['expr 1 + 2 + 3', '6\n', '', 0],
    ["expr '(' 2 + 3 ')' '*' 4", '20\n', '', 0],
    ["expr length '(' abc ')'", '3\n', '', 0],
    ['expr length abcde', '5\n', '', 0],
    ['expr index abcde ec', '3\n', '', 0],
    ['expr substr abcde 2 3', 'bcd\n', '', 0],
    ['expr substr abcde 0 3', '\n', '', 1],
    ['expr substr abc x 1', '\n', '', 1],
    ["expr match abcdef 'a\\(bc\\)'", 'bc\n', '', 0],
    ["expr abc ':' '[[:alpha:]]\\+'", '3\n', '', 0],
    ["expr 'a+b' ':' 'a+b'", '3\n', '', 0],
    ["expr abc ':' 'a\\|b'", '1\n', '', 0],
    ["expr abc ':' 'a|b'", '0\n', '', 1],
    ["expr aab ':' 'a\\{2\\}'", '2\n', '', 0],
    ["expr aab ':' 'a{2}'", '0\n', '', 1],
    ["expr '*a' ':' '*a'", '2\n', '', 0],
    ["expr abc ':' '\\w\\+'", '3\n', '', 0],
    ["expr aab ':' '\\(a\\)\\1'", 'a\n', '', 0],
    ["expr 1 '|' 1 '/' 0", '1\n', '', 0],
    ["expr 0 '&' 1 '/' 0", '0\n', '', 1],
    ["expr 2 '|' 0 '&' 0", '2\n', '', 0],
    ["expr 10 '%' 4 '*' 2", '4\n', '', 0],
    ['expr -5 + 3', '-2\n', '', 0],
    ['expr + length', 'length\n', '', 0],
    ['expr 1 + + 2', '3\n', '', 0],
    ["expr '+1' '=' 1", '0\n', '', 1],
    ["expr 1 '==' 1", '1\n', '', 0],
    ['expr -- 1 + 2', '3\n', '', 0],
    ['expr -- --version', '--version\n', '', 0],
    ['expr', '', "expr: missing operand\nTry 'expr --help' for more information.\n", 2],
    ['expr --', '', "expr: missing operand\nTry 'expr --help' for more information.\n", 2],
    ['expr 1 +', '', "expr: syntax error: missing argument after '+'\n", 2],
    ['expr 1 2 3', '', "expr: syntax error: unexpected argument '2'\n", 2],
    ["expr '(' 1 + 2", '', "expr: syntax error: expecting ')' after '2'\n", 2],
    ["expr '(' ')'", '', "expr: syntax error: unexpected ')'\n", 2],
    ["expr abc ':' '\\('", '', 'expr: Unmatched ( or \\(\n', 2],
    // The byte rows that still render as valid UTF-8, so the whole shell
    // path is pinned and not only `exprEval`.
    ['expr length \u00e9\u00e9', '4\n', '', 0],
    ['expr substr \u00e9\u00e9 1 2', '\u00e9\n', '', 0],
    ['expr index \u00e4 \u00e9', '1\n', '', 0],
    ["expr 2 '<' " + BEYOND_FLOAT, '1\n', '', 0],
    ["expr 2 '>' " + BEYOND_FLOAT, '0\n', '', 1],
    ["expr 1000000000000 '*' 1000000000000", '1' + '0'.repeat(24) + '\n', '', 0],
    ['expr substr \u00e9\u00e9 3 2', '\u00e9\n', '', 0],
    ["expr \u00e9 ':' '..'", '2\n', '', 0],
    ["expr $'12\\n' + 1", '', 'expr: non-integer argument\n', 2],
    // The two diagnostic-wording families, through the whole shell path:
    // gnulib's quote() escaping the word, and the `instead of` clause.
    ["expr a '\\(' 2", '', "expr: syntax error: unexpected argument '\\\\('\n", 2],
    ["expr '(' '\\('", '', "expr: syntax error: expecting ')' after '\\\\('\n", 2],
    ["expr '(' \u00e9", '', "expr: syntax error: expecting ')' after '\\303\\251'\n", 2],
    ["expr '(' $'a\\tb'", '', "expr: syntax error: expecting ')' after 'a\\tb'\n", 2],
    ["expr '(' 1 1", '', "expr: syntax error: expecting ')' instead of '1'\n", 2],
    ["expr '(' 1 2 ')'", '', "expr: syntax error: expecting ')' instead of '2'\n", 2],
    ["expr '(' 1", '', "expr: syntax error: expecting ')' after '1'\n", 2],
    ["expr '(' 1 +", '', "expr: syntax error: missing argument after '+'\n", 2],
  ])('%s', async (line, out, err, exitCode) => {
    const ws = await makeWs()
    const io = await ws.execute(line)
    expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual([out, err, exitCode])
    await ws.close()
  })

  it('writes the bytes a split character leaves', async () => {
    // The whole way through the shell: `substr` cut the first character
    // in half, so stdout is one invalid byte and not a replacement
    // character. GNU writes `a9 c3` here.
    const ws = await makeWs()
    const io = await ws.execute('expr substr \u00e9\u00e9 2 2')
    expect([...io.stdout]).toEqual([0xa9, 0xc3, 0x0a])
    expect(io.exitCode).toBe(0)
    await ws.close()
  })
})
