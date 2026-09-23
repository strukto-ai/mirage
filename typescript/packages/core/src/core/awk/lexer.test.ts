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
import { AwkSyntaxError } from './errors.ts'
import { TokKind, tokenize } from './lexer.ts'

function kinds(src: string): [TokKind, string][] {
  return tokenize(src)
    .slice(0, -1)
    .map((t) => [t.kind, t.text])
}

describe('awk lexer', () => {
  it('divides after an operand and opens a regex elsewhere', () => {
    expect(kinds('a / b')).toEqual([
      [TokKind.NAME, 'a'],
      [TokKind.OP, '/'],
      [TokKind.NAME, 'b'],
    ])
    expect(kinds('$0 ~ /a\\/b/')).toEqual([
      [TokKind.OP, '$'],
      [TokKind.NUMBER, '0'],
      [TokKind.OP, '~'],
      [TokKind.ERE, 'a/b'],
    ])
  })

  it('reads a name glued to a paren as a call', () => {
    expect(kinds('f(1)')[0]).toEqual([TokKind.FUNC_NAME, 'f'])
    expect(kinds('f (1)')[0]).toEqual([TokKind.NAME, 'f'])
  })

  it('expands string escapes and octal', () => {
    expect(tokenize('"a\\tb\\101\\""')[0]?.value).toBe('a\tbA"')
  })

  it('folds both power spellings to a caret', () => {
    expect(kinds('a ** b **= c').map((k) => k[1])).toEqual(['a', '^', 'b', '^=', 'c'])
  })

  it('takes a fraction and an exponent', () => {
    expect(kinds('1 .5 1e3 2.5E-2 1e').map((k) => k[1])).toEqual([
      '1',
      '.5',
      '1e3',
      '2.5E-2',
      '1',
      'e',
    ])
  })

  it('skips a comment and a continuation', () => {
    expect(kinds('a # note\n\\\nb')).toEqual([
      [TokKind.NAME, 'a'],
      [TokKind.NEWLINE, '\n'],
      [TokKind.NAME, 'b'],
    ])
  })

  it('refuses a non-ASCII letter as a name', () => {
    expect(() => tokenize('é = 1')).toThrow('unexpected character')
  })

  it.each(['"open', '/open', '"a\nb"'])('refuses the unterminated literal %j', (src) => {
    expect(() => tokenize(src)).toThrow(AwkSyntaxError)
  })
})
