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
import { breToEre, executeProgram, parseProgram } from './sed_helper.ts'

function sed(expr: string, input: string, suppress = false, extended = false): string {
  return executeProgram(input, parseProgram(expr), suppress, extended)
}

// ERE convenience: sed -E
function sedE(expr: string, input: string): string {
  return sed(expr, input, false, true)
}

describe('sed line anchors (^ and $)', () => {
  // Regression for #326: ^/$ must anchor per line, matching Python sed / GNU sed.
  it('anchored substitution applies per line', () => {
    expect(sed('s/^#[0-9]*$/#TS/', '#123\nls\n')).toBe('#TS\nls\n')
  })

  it('anchored substitution with -E style + quantifier', () => {
    expect(sedE('s/^#[0-9]+$/#TS/', '#123\nls\n')).toBe('#TS\nls\n')
  })

  it('anchored substitution with global flag', () => {
    expect(sed('s/^#[0-9]*$/#TS/g', '#123\nls\n')).toBe('#TS\nls\n')
  })

  it('unanchored substitution still works', () => {
    expect(sed('s/#[0-9][0-9]*/#TS/', '#123\nls\n')).toBe('#TS\nls\n')
  })

  it('$ anchor does not match mid-line', () => {
    expect(sed('s/o$/0/', 'foo\nfox\n')).toBe('fo0\nfox\n')
  })

  it('^ anchor only matches line start', () => {
    expect(sed('s/^a/X/', 'abc\nbac\n')).toBe('Xbc\nbac\n')
  })

  it('anchored substitution on last line without trailing newline', () => {
    expect(sed('s/^bar$/BAR/', 'foo\nbar')).toBe('foo\nBAR')
  })

  it('regex address with $ anchor matches per line', () => {
    // delete lines that consist solely of digits
    expect(sed('/^[0-9]*$/d', '12\nab\n34\n')).toBe('ab\n')
  })
})

describe('sed s/// flags', () => {
  it('numeric count replaces only the Nth occurrence', () => {
    expect(sed('s/o/O/2', 'oooo\n')).toBe('oOoo\n')
    expect(sed('s/o/O/3', 'oooo\n')).toBe('ooOo\n')
  })

  it('numeric count with g replaces the Nth and all later occurrences', () => {
    expect(sed('s/o/O/2g', 'oooo\n')).toBe('oOOO\n')
  })

  it('count is per line', () => {
    expect(sed('s/o/O/2', 'oo\noo\n')).toBe('oO\noO\n')
  })

  it('no count, no g replaces first; g replaces all', () => {
    expect(sed('s/o/O/', 'oooo\n')).toBe('Oooo\n')
    expect(sed('s/o/O/g', 'oooo\n')).toBe('OOOO\n')
  })

  it('p flag prints the pattern space when a substitution is made', () => {
    // without -n the line is emitted twice on a match, once via p
    expect(sed('s/hi/HI/p', 'hi\nbye\n')).toBe('HI\nHI\nbye\n')
  })

  it('p flag under -n prints only substituted lines', () => {
    expect(sed('s/hi/HI/p', 'hi\nbye\n', true)).toBe('HI\n')
  })

  it('count combines with case-insensitive flag', () => {
    expect(sed('s/o/X/2i', 'oOoO\n')).toBe('oXoO\n')
  })
})

describe('sed y (transliterate)', () => {
  it('translates characters by position', () => {
    expect(sed('y/el/ip/', 'hello\n')).toBe('hippo\n')
  })

  it('leaves unmatched characters unchanged', () => {
    expect(sed('y/-/ /', 'a-b-c\n')).toBe('a b c\n')
  })

  it('applies per line and preserves newlines', () => {
    expect(sed('y/abc/xyz/', 'cab\nbac\n')).toBe('zxy\nyxz\n')
  })

  it('rejects mismatched source/dest lengths', () => {
    expect(() => parseProgram('y/ab/x/')).toThrow()
  })
})

describe('sed c (change)', () => {
  it('changes every line when given no address', () => {
    expect(sed('c\\\nX', 'a\nb\nc\n')).toBe('X\nX\nX\n')
  })

  it('changes a single addressed line', () => {
    expect(sed('2c\\\nX', 'a\nb\nc\n')).toBe('a\nX\nc\n')
  })

  it('changes a regex-addressed line', () => {
    expect(sed('/foo/c\\\nCHANGED', 'foo\nbar\n')).toBe('CHANGED\nbar\n')
  })

  it('emits the text once for a line range', () => {
    expect(sed('2,3c\\\nX', 'a\nb\nc\nd\n')).toBe('a\nX\nd\n')
  })
})

describe('sed address negation (addr!cmd)', () => {
  it('negated line address applies to all other lines', () => {
    expect(sed('2!d', 'a\nb\nc\n')).toBe('b\n')
  })

  it('negated regex address keeps only non-matching lines', () => {
    expect(sed('/b/!d', 'a\nb\nc\n')).toBe('b\n')
  })

  it('negated last-line with -n prints all but the last', () => {
    expect(sed('$!p', 'a\nb\nc\n', true)).toBe('a\nb\n')
  })

  it('negated range substitutes outside the range', () => {
    expect(sed('1,2!s/./X/', 'a\nb\nc\nd\n')).toBe('a\nb\nX\nX\n')
  })

  it('whitespace is allowed around the negation', () => {
    expect(sed('2 ! d', 'a\nb\nc\n')).toBe('b\n')
  })
})

describe('sed replacement & hold-space (GNU semantics)', () => {
  it('unescaped & is the whole match', () => {
    expect(sed('s/wor/[&]/', 'world\n')).toBe('[wor]ld\n')
  })

  it('escaped \\& is a literal ampersand', () => {
    expect(sed('s/wor/[\\&]/', 'world\n')).toBe('[&]ld\n')
  })

  it('G appends a blank line when the hold space is empty', () => {
    expect(sed('G', 'a\nb\n')).toBe('a\n\nb\n\n')
  })

  it('H accumulates with a leading newline from an empty hold', () => {
    expect(sed('H;${x;p}', 'a\nb\n', true)).toBe('\na\nb\n')
  })
})

describe('sed multi-line pattern space (N / join / final newline)', () => {
  it('joins all lines (the :a;N;$!ba idiom) with no trailing separator', () => {
    expect(sed(':a;N;$!ba;s/\\n/,/g', 'a\nb\nc\n')).toBe('a,b,c\n')
  })

  it('N joins line pairs', () => {
    expect(sed('N;s/\\n/ /', 'a\nb\nc\nd\n')).toBe('a b\nc d\n')
  })

  it('preserves a missing final newline', () => {
    expect(sed('s/o/O/', 'foo')).toBe('fOo')
    expect(sed('p', 'foo', true)).toBe('foo')
  })

  it('a line number address tracks the last line read after N', () => {
    // after N, line 2 is current → $ matches and appends the hold (blank line)
    expect(sed('N;$G', 'a\nb\n')).toBe('a\nb\n\n')
  })
})

describe('breToEre translation', () => {
  it('swaps backslashed and bare metacharacters', () => {
    expect(breToEre('a\\+')).toBe('a+')
    expect(breToEre('a+')).toBe('a\\+')
    expect(breToEre('\\(foo\\)')).toBe('(foo)')
    expect(breToEre('(foo)')).toBe('\\(foo\\)')
    expect(breToEre('a\\{2\\}')).toBe('a{2}')
    expect(breToEre('cat\\|dog')).toBe('cat|dog')
  })

  it('keeps bracket expressions verbatim', () => {
    expect(breToEre('[a+b]')).toBe('[a+b]')
    expect(breToEre('[^]x]')).toBe('[^]x]')
  })

  it('treats a leading * as literal and ^/$ positionally', () => {
    expect(breToEre('*x')).toBe('\\*x')
    expect(breToEre('a^b')).toBe('a\\^b')
    expect(breToEre('a$b')).toBe('a\\$b')
    expect(breToEre('^ab$')).toBe('^ab$')
  })
})

describe('sed BRE (default) vs ERE (-E)', () => {
  it('BRE: \\( \\) are groups, bare () are literal', () => {
    expect(sed('s/\\(foo\\)/[\\1]/', 'foo\n')).toBe('[foo]\n')
    expect(sed('s/(x)/Y/', '(x)\n')).toBe('Y\n')
  })

  it('BRE: \\+ is one-or-more, bare + is literal', () => {
    expect(sed('s/a\\+/X/', 'aaab\n')).toBe('Xb\n')
    expect(sed('s/a+/X/', 'a+b\n')).toBe('Xb\n')
  })

  it('BRE: \\{n\\} interval and \\| alternation', () => {
    expect(sed('s/a\\{2\\}/X/', 'aaa\n')).toBe('Xa\n')
    expect(sed('s/cat\\|dog/PET/', 'cat\n')).toBe('PET\n')
  })

  it('ERE: bare () are groups, + is one-or-more', () => {
    expect(sedE('s/(foo)/[\\1]/', 'foo\n')).toBe('[foo]\n')
    expect(sedE('s/a+/X/', 'aaab\n')).toBe('Xb\n')
    expect(sedE('s/cat|dog/PET/', 'dog\n')).toBe('PET\n')
  })

  it('regex addresses honor BRE/ERE too', () => {
    expect(sed('/a\\+/d', 'aaa\nbbb\n')).toBe('bbb\n')
    expect(sedE('/a+/d', 'aaa\nbbb\n')).toBe('bbb\n')
  })
})

describe('sed s/// edge cases', () => {
  it('handles an escaped delimiter in the pattern', () => {
    expect(sed('s/a\\/b/c/', 'a/b\n')).toBe('c\n')
  })

  it('handles an escaped delimiter in the replacement', () => {
    expect(sed('s/x/a\\/b/', 'x\n')).toBe('a/b\n')
  })

  it('rejects a zero occurrence count', () => {
    expect(() => parseProgram('s/o/O/0')).toThrow(/may not be zero/)
  })
})
