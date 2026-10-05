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
import { byteView, fromByteView } from '../../shell/bytes.ts'
import { SedMachine, listLine, type SedFileContent, type SedInput } from './sed_exec.ts'
import { compileScript } from './sed_script.ts'

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  wfiles: Map<string, string>
}

function run(
  exprs: string | string[],
  inputs: string | SedInput[],
  opts: {
    suppress?: boolean
    extended?: boolean
    separate?: boolean
    lineLength?: number
    files?: Record<string, SedFileContent>
  } = {},
): RunResult {
  const pieces = (Array.isArray(exprs) ? exprs : [exprs]).map((text) => ({
    kind: 'expr' as const,
    text,
  }))
  const machine = new SedMachine(compileScript(pieces, opts.extended ?? false), {
    suppress: opts.suppress ?? false,
    separate: opts.separate ?? false,
    lineLength: opts.lineLength ?? 70,
    files: new Map(Object.entries(opts.files ?? {})),
    readerFiles: new Map(Object.entries(opts.files ?? {})),
  })
  machine.process(
    typeof inputs === 'string' ? [{ name: '-', text: byteView(inputs) }] : inputs,
    true,
  )
  const wfiles = new Map<string, string>()
  for (const [name, out] of machine.wfiles) wfiles.set(name, out.chunks.join(''))
  return {
    stdout: machine.stdout.chunks.join(''),
    stderr: machine.stderr(),
    exitCode: machine.exitCode(),
    wfiles,
  }
}

function sed(expr: string, input: string, suppress = false, extended = false): string {
  return run(expr, input, { suppress, extended }).stdout
}

function latin1Bytes(text: string): number[] {
  return Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
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

  it('skips an empty match touching the previous match', () => {
    expect(sedE('s/b*/X/g', 'abbb\n')).toBe('XaX\n')
    expect(sed('s/x*/-/g', 'abxd\n')).toBe('-a-b-d-\n')
  })

  it('does not count a skipped empty match', () => {
    expect(sedE('s/b*/X/2', 'abbb\n')).toBe('aX\n')
    expect(sedE('s/b*/X/3', 'abbb\n')).toBe('abbb\n')
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
    expect(() => sed('y/ab/x/', '')).toThrow("strings for `y' command are different lengths")
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

describe('sed a, i and c text (GNU sed 4.9)', () => {
  it('drops a backslash before an ordinary character', () => {
    expect(sed('a one\\/two', 'x\n')).toBe('x\none/two\n')
    expect(sed('i one\\/two', 'x\n')).toBe('one/two\nx\n')
    expect(sed('c one\\/two', 'x\n')).toBe('one/two\n')
    expect(sed("/^bibtexurl:/a codeurl: 'https:\\/\\/github.com\\/u\\/r'", 'bibtexurl: x\n')).toBe(
      "bibtexurl: x\ncodeurl: 'https://github.com/u/r'\n",
    )
  })

  it('decodes the text escapes', () => {
    expect(sed('a one\\/two\\tthree', 'x\n')).toBe('x\none/two\tthree\n')
    expect(sed('a x\\ny', 'x\n')).toBe('x\nx\ny\n')
    expect(sed('a x\\\\y', 'x\n')).toBe('x\nx\\y\n')
    expect(sed('a x\\by', 'x\n')).toBe('x\nxby\n')
    expect(sed('a 1\\a2\\f3\\v4\\r5', 'x\n')).toBe('x\n1\x072\f3\v4\r5\n')
  })

  it('decodes numeric and control escapes', () => {
    expect(sed('a [\\d065][\\x41][\\o101][\\x4][\\xZ][\\d300]', 'x\n')).toBe(
      'x\n[A][A][A][\x04][xZ][,]\n',
    )
    expect(sed('a [\\cA][\\ca][\\c?][\\c\\\\]', 'x\n')).toBe('x\n[\x01][\x01][\x7f][\x1c]\n')
    expect(() => sed('a [\\c\\d]', 'x\n')).toThrow('recursive escaping after \\c not allowed')
  })

  it('writes numeric escapes above ASCII as raw bytes', () => {
    const out = sed('a [\\xff][\\d200][\\o377][\\x80][\\xc3\\xa9][\\o400]', 'x\n')
    expect([...fromByteView(out)]).toEqual(
      latin1Bytes('x\n[\xff][\xc8][\xff][\x80][\xc3\xa9][\x00]\n'),
    )
  })

  it('lets a final \\c take the closing newline', () => {
    expect(sed('a foo\\c', 'x\ny\n')).toBe('x\nfooJy\nfooJ')
    expect(sed('i foo\\c', 'x\n')).toBe('foo\nx\n')
  })

  it('skips blanks before one-line text and keeps them after a backslash', () => {
    expect(sed('a  \t foo', 'x\n')).toBe('x\nfoo\n')
    expect(sed('a\\   foo', 'x\n')).toBe('x\n   foo\n')
    expect(sed('a\\tfoo', 'x\n')).toBe('x\ntfoo\n')
    expect(sed('a \\tfoo', 'x\n')).toBe('x\ntfoo\n')
    expect(sed('a\\\\tfoo', 'x\n')).toBe('x\n\tfoo\n')
  })

  it('reads the classic form and continued lines', () => {
    expect(sed('a\\\n  l1\\\n  l2', 'x\n')).toBe('x\n  l1\n  l2\n')
    expect(sed('i\\\nl1\\\nl2', 'x\n')).toBe('l1\nl2\nx\n')
    expect(sed('a foo\\\nbar', 'x\n')).toBe('x\nfoo\nbar\n')
  })

  it('ends the text at a newline and not at a semicolon', () => {
    expect(sed('1a foo\n2d', 'x\ny\n')).toBe('x\nfoo\n')
    expect(sed('1a foo; 2d', 'x\ny\n')).toBe('x\nfoo; 2d\ny\n')
    expect(sed('a int x = 1; echo bar', 'x\n')).toBe('x\nint x = 1; echo bar\n')
  })

  it('keeps trailing blanks', () => {
    expect(sed('1d\n$a foo   ', 'x\ny\n')).toBe('y\nfoo   \n')
  })

  it('leaves the text undecoded when the script ends on a backslash', () => {
    expect(sed('a one\\/two\\', 'x\n')).toBe('x\none\\/two\n')
    expect(sed('a\\', 'x\ny\n')).toBe('x\ny\n')
    expect(sed('c\\', 'x\ny\n')).toBe('')
  })

  it('refuses a missing text and a block the text left open', () => {
    expect(() => sed('a', 'x\n')).toThrow("expected \\ after `a', `c' or `i'")
    expect(() => sed('1{a foo;}', 'x\ny\n')).toThrow("unmatched `{'")
    expect(sed('1{a foo\n}', 'x\ny\n')).toBe('x\nfoo\ny\n')
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
    expect(() => sed('s/o/O/0', '')).toThrow(/may not be zero/)
  })
})

describe('sed address delimiters', () => {
  it('escaped delimiter inside an address regex is a literal slash', () => {
    expect(sed('/a\\/b/d', 'x\na/b\ny\n')).toBe('x\ny\n')
  })

  it('custom-delimiter address form \\cREc', () => {
    expect(sed('\\%a/b%d', 'a/b\nz\n')).toBe('z\n')
  })

  it('BRE escapes inside an address survive to the regex', () => {
    expect(sed('/a\\+b/d', 'x\na+b\naab\ny\n')).toBe('x\na+b\ny\n')
  })

  it('range addresses honor escaped delimiters', () => {
    expect(sed('/a\\/b/,/c\\/d/d', 'x\na/b\nmid\nc/d\ny\n')).toBe('x\ny\n')
  })

  it('unterminated address regex throws', () => {
    expect(() => sed('/a\\/b', 'x\n')).toThrow('unterminated address regex')
  })
})

describe('sed replacement uses the original match', () => {
  it('preserves word boundary context', () => {
    expect(sed(String.raw`s/\Ba/X/g`, 'ba a\n')).toBe('bX a\n')
  })
  it('expands zero and single-digit captures without changing case', () => {
    expect(sed(String.raw`s/\(a\)b/[\0:\1:&:\10]/I`, 'Ab\n')).toBe('[Ab:A:Ab:A0]\n')
  })
  it('keeps unmatched groups empty and dollar signs literal', () => {
    expect(sedE(String.raw`s/(a)(b)?/[\1:\2:$&]/I`, 'A\n')).toBe('[A::$A]\n')
  })
})

it.each([
  ['2b\ns/./X/', 'a\nb\nc\nd\n', 'X\nb\nX\nX\n'],
  ['1b\n$!d', 'a\nb\nc\nd\n', 'a\nd\n'],
  ['s/a/A/\nt\ns/./X/', 'a\nb\n', 'A\nX\n'],
  ['1b done\ns/./X/\n:done\ns/$/!/', 'a\nb\n', 'a!\nX!\n'],
])('branch and label end at newline: %s', (script, text, expected) => {
  expect(sed(script, text)).toBe(expected)
})

it.each([
  ['s/.*/\\U&/', 'hello world\n', 'HELLO WORLD\n'],
  ['s/\\w\\+/\\u&/g', 'hello world\n', 'Hello World\n'],
  ['s/\\(o\\) \\(w\\)/\\U\\1\\E \\2/', 'hello world\n', 'hellO world\n'],
  ['s/.*/\\u\\L&/', 'hELLO\n', 'hello\n'],
  ['s/.*/\\L\\u&/', 'hELLO\n', 'Hello\n'],
  ['s/\\(x*\\)\\(a\\)/\\u\\1\\2/', 'ab\n', 'Ab\n'],
  ['s/abc/\\u\\lX/', 'abc\n', 'x\n'],
  ['s/\\(x*\\)a/\\u\\1\\Lz/', 'a\n', 'z\n'],
  ['s/\\(x*\\)a/\\l\\1\\UZz/', 'a\n', 'ZZ\n'],
  ['s/\\(x*\\)a\\(b\\)/\\u\\1\\E\\2/', 'ab\n', 'b\n'],
  ['s/\\(x*\\)a/\\u\\1\\l\\1\\Uq/', 'ab\n', 'Qb\n'],
  ['s/\\(x*\\)\\(y*\\)\\(a\\)/\\u\\1\\2\\3/', 'ab\n', 'ab\n'],
  ['s/.*/\\U&/', 'a\u00e9\n', byteView('A\u00e9\n')],
])('case conversion: %s', (script, text, expected) => {
  expect(sed(script, text)).toBe(expected)
})

describe('sed l (GNU sed 4.9)', () => {
  it('shows C escapes, a doubled backslash and octal for other bytes', () => {
    expect(listLine('a\tb\\c\x01', 70)).toBe('a\\tb\\\\c\\001$\n')
    expect(listLine('x\x7f\x1b\r\f\v\b\x07', 70)).toBe('x\\177\\033\\r\\f\\v\\b\\a$\n')
  })

  it('shows every byte of a multibyte character in octal', () => {
    expect(listLine(byteView('café'), 70)).toBe('caf\\303\\251$\n')
  })

  it('shows a raw byte as itself in octal', () => {
    expect(listLine(byteView(new Uint8Array([0xff])), 70)).toBe('\\377$\n')
  })

  it('folds at 69 characters and a backslash', () => {
    expect(listLine('0'.repeat(69), 70)).toBe(`${'0'.repeat(69)}$\n`)
    expect(listLine('0'.repeat(70), 70)).toBe(`${'0'.repeat(69)}\\\n0$\n`)
  })

  it('never splits an escape across a fold', () => {
    expect(listLine('aaa\tb', 5)).toBe('aaa\\\n\\tb$\n')
  })

  it('does not fold at width 0 and folds before every character at 1', () => {
    expect(listLine('abc', 0)).toBe('abc$\n')
    expect(listLine('ab', 1)).toBe('\\\na\\\nb$\n')
  })

  it('takes its width from `l N`, then -l, then 70', () => {
    expect(run('l 5', 'abcdefgh\n', { suppress: true }).stdout).toBe('abcd\\\nefgh$\n')
    expect(run('l', 'abcdefgh\n', { suppress: true, lineLength: 5 }).stdout).toBe('abcd\\\nefgh$\n')
    expect(run('l;l 0', 'abcdefgh\n', { suppress: true, lineLength: 5 }).stdout).toBe(
      'abcd\\\nefgh$\nabcdefgh$\n',
    )
  })

  it('shows the embedded newline and always ends its own line', () => {
    expect(run('N;l', 'a\nb\n', { suppress: true }).stdout).toBe('a\\nb$\n')
    expect(sed('l', 'abc')).toBe('abc$\nabc')
  })
})

describe('sed = n N D', () => {
  it('= prints the line number, before the missing newline is due', () => {
    expect(run('$=', 'a\nb\nc\n', { suppress: true }).stdout).toBe('3\n')
    expect(run('p;=', 'a\nb', { suppress: true }).stdout).toBe('a\n1\nb\n2\n')
  })

  it('n prints and reads on; at the end it quits without printing again', () => {
    expect(run('n;p', 'a\nb\nc\n', { suppress: true }).stdout).toBe('b\n')
    expect(sed('n;d', 'a\nb\nc\n')).toBe('a\nc\n')
    expect(sed('n', 'a\n')).toBe('a\n')
    expect(run('n;p', 'a\n', { suppress: true }).stdout).toBe('')
  })

  it('n and N write the append queue before reading', () => {
    expect(sed('n;a X', 'a\nb\nc\n')).toBe('a\nb\nX\nc\n')
    expect(run(['a X', 'N'], 'a\nb\n').stdout).toBe('X\na\nb\n')
  })

  it('reading a line clears the substitution flag', () => {
    expect(sed('s/a/X/;n;T;s/$/!/', 'a\nb\n')).toBe('X\nb\n')
  })

  it('N at the end prints the pattern space', () => {
    expect(sed('N', 'a\nb\nc\n')).toBe('a\nb\nc\n')
    expect(run('N;p', 'a\nb\nc\n', { suppress: true }).stdout).toBe('a\nb\n')
    expect(sed('$!N;P;D', 'a\nb\nc\n')).toBe('a\nb\nc\n')
  })
})

describe('sed q Q T z', () => {
  it('q prints, writes the append queue and exits with its code', () => {
    const r = run(['1a X', '1q5'], 'a\nb\n')
    expect(r.stdout).toBe('a\nX\n')
    expect(r.exitCode).toBe(5)
    expect(run('2q 300', 'a\nb\nc\n').exitCode).toBe(44)
  })

  it('Q quits without printing or the append queue', () => {
    const r = run(['1a X', '1Q7'], 'a\nb\n')
    expect(r.stdout).toBe('')
    expect(r.exitCode).toBe(7)
  })

  it('T branches when there was no substitution', () => {
    expect(sed('s/a/A/;T;s/$/!/', 'a\nb\nc\n')).toBe('A!\nb\nc\n')
  })

  it('z empties the pattern space', () => {
    expect(sed('z;s/^$/E/', 'a\nb\n')).toBe('E\nE\n')
  })
})

describe('sed r R w W F', () => {
  const files = { '/r': { text: 'R1\nR2\n' }, '/nonl': { text: 'x' } }

  it('r queues the file for the end of the cycle', () => {
    expect(run('r /r', 'a\nb\n', { files }).stdout).toBe('a\nR1\nR2\nb\nR1\nR2\n')
    expect(run(['1r /r', '1a X'], 'a\nb\n', { files }).stdout).toBe('a\nR1\nR2\nX\nb\n')
    expect(run(['1r /r', '1d'], 'a\nb\n', { files }).stdout).toBe('R1\nR2\nb\n')
  })

  it('r writes a file without a final newline as it is', () => {
    expect(run('r /nonl', 'a\nb\n', { files }).stdout).toBe('a\nxb\nx')
  })

  it('0r writes the file before the first line', () => {
    expect(run('0r /r', 'a\nb\n', { files }).stdout).toBe('R1\nR2\na\nb\n')
  })

  it('r and R ignore a file that cannot be opened', () => {
    expect(run('1r /nope', 'a\nb\n', { files }).stdout).toBe('a\nb\n')
    expect(run('R /nope', 'a\nb\n', { files }).stdout).toBe('a\nb\n')
  })

  it('r of a directory is a read error, exit 4', () => {
    const r = run('r /d', 'a\nb\n', {
      files: { '/d': { error: 'sed: read error on /d: Is a directory\n' } },
    })
    expect(r.stdout).toBe('a\n')
    expect(r.stderr).toBe('sed: read error on /d: Is a directory\n')
    expect(r.exitCode).toBe(4)
  })

  it('R appends one line per run and shares the reader', () => {
    expect(run('R /r', 'a\nb\nc\n', { files }).stdout).toBe('a\nR1\nb\nR2\nc\n')
    expect(run(['R /r', 'R /r'], 'a\nb\n', { files }).stdout).toBe('a\nR1\nR2\nb\n')
  })

  it('R rewinds for each file under -s', () => {
    const inputs = [
      { name: 'f', text: 'a\n' },
      { name: 'f', text: 'a\n' },
    ]
    expect(run('R /r', inputs, { files }).stdout).toBe('a\nR1\na\nR2\n')
    expect(run('R /r', inputs, { files, separate: true }).stdout).toBe('a\nR1\na\nR1\n')
  })

  it('w and W write the pattern space, s///w only a changed one', () => {
    expect(run('w /o', 'a\nb', { suppress: true }).wfiles.get('/o')).toBe('a\nb')
    expect(run('N;W /o', 'a\nb\nc\n', { suppress: true }).wfiles.get('/o')).toBe('a\n')
    expect(run('s/a/X/w /o', 'a\nb\n').wfiles.get('/o')).toBe('X\n')
    expect(run(['1w /o', '2w /o'], 'a\nb\n', { suppress: true }).wfiles.get('/o')).toBe('a\nb\n')
  })

  it('/dev/stdout interleaves with the output, with its own missing newline', () => {
    expect(sed('w /dev/stdout', 'a\nb\n')).toBe('a\na\nb\nb\n')
    expect(sed('w /dev/stdout', 'a\nb')).toBe('a\na\nbb')
    expect(sed('s/a/X/w /dev/stdout', 'a\nb\n')).toBe('X\nX\nb\n')
  })

  it('/dev/stderr goes to the error stream', () => {
    const r = run('1w /dev/stderr', 'a\nb\n', { suppress: true })
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('a\n')
  })

  it('F prints the file name, - for stdin', () => {
    expect(sed('F', 'a\n')).toBe('-\na\n')
    expect(
      run('F', [
        { name: '/f1', text: 'a\n' },
        { name: 'f2', text: 'b\n' },
      ]).stdout,
    ).toBe('/f1\na\nf2\nb\n')
  })
})

describe('sed addresses (GNU sed 4.9)', () => {
  it('reads first~step, addr,+N, addr,~N and 0,/re/', () => {
    expect(sed('1~2!d', 'a\nb\nc\n')).toBe('a\nc\n')
    expect(run('2,+1p', 'a\nb\nc\n', { suppress: true }).stdout).toBe('b\nc\n')
    expect(run('2,~4p', 'a\nb\nc\nd\ne\n', { suppress: true }).stdout).toBe('b\nc\nd\n')
    expect(run('0,/a/p', 'a\nb\n', { suppress: true }).stdout).toBe('a\n')
    expect(run('1,/a/p', 'a\nb\n', { suppress: true }).stdout).toBe('a\nb\n')
  })

  it('a regex range spans at least two lines; a line range ending before it one', () => {
    expect(run('/a/,/a/p', 'a\nb\na\nc\n', { suppress: true }).stdout).toBe('a\nb\na\n')
    expect(run('2,1p', 'a\nb\nc\n', { suppress: true }).stdout).toBe('b\n')
    expect(run('/b/,1p', 'a\nb\nc\n', { suppress: true }).stdout).toBe('b\n')
  })

  it('c on a range prints once, when it closes, and never if it stays open', () => {
    expect(sed('2,3cX', 'a\nb\nc\nd\n')).toBe('a\nX\nd\n')
    expect(sed('1,/x/c\\\nX', 'a\nb\n')).toBe('')
    expect(sed('2,3!cX', 'a\nb\nc\nd\n')).toBe('X\nb\nc\nX\n')
  })

  it('an empty regex is the last one used', () => {
    expect(run('/b/{//p}', 'abc\n', { suppress: true }).stdout).toBe('abc\n')
    expect(sed('s/b/X/;s//Y/', 'abc\n')).toBe('aXc\n')
    const r = run('//p', 'abc\n')
    expect(r.stderr).toBe('sed: -e expression #1, char 0: no previous regular expression\n')
    expect(r.exitCode).toBe(1)
  })

  it('I and M modify an address or s', () => {
    expect(run('/A/Ip', 'a\nb\n', { suppress: true }).stdout).toBe('a\n')
    expect(sed('N;s/^b/>/M', 'a\nb\n')).toBe('a\n>\n')
    expect(sed('N;s/^b/>/', 'a\nb\n')).toBe('a\nb\n')
  })
})

describe('sed streams and files', () => {
  it('writes a missing newline before anything else goes out', () => {
    expect(sed('p', 'a')).toBe('a\na')
    expect(sed('a X', 'a\nb')).toBe('a\nX\nb\nX\n')
    expect(sed('i X', 'a')).toBe('X\na')
  })

  it('reads $ across files, skipping empty ones, or per file under -s', () => {
    const inputs = [
      { name: 'f', text: 'one\ntwo\n' },
      { name: 'g', text: 'x\ny\n' },
      { name: 'e', text: '' },
    ]
    expect(run('$=', inputs, { suppress: true }).stdout).toBe('4\n')
    expect(run('$=', inputs, { suppress: true, separate: true }).stdout).toBe('2\n2\n')
    expect(run('1h;2G', inputs.slice(0, 2), { separate: true }).stdout).toBe(
      'one\ntwo\none\nx\ny\nx\n',
    )
  })

  it('reports an operand it cannot open when it gets there and goes on', () => {
    const missing = {
      name: 'nope',
      error: "sed: can't read nope: No such file or directory\n",
      code: 2,
      fatal: false,
    }
    const r = run('p', [{ name: 'f', text: 'a\n' }, missing, { name: 'g', text: 'b\n' }], {
      suppress: true,
    })
    expect(r.stdout).toBe('a\nb\n')
    expect(r.exitCode).toBe(2)
  })

  it('never opens an operand after q, and a failed one outranks q', () => {
    const missing = { name: 'nope', error: "sed: can't read nope: x\n", code: 2, fatal: false }
    const after = run('2{p;q}', [{ name: 'f', text: 'one\ntwo\n' }, missing], {
      suppress: true,
    })
    expect(after.stdout).toBe('two\n')
    expect(after.exitCode).toBe(0)
    expect(run('Q3', [missing, { name: 'f', text: 'one\n' }]).exitCode).toBe(2)
  })

  it('skips a directory while looking for $, as GNU does, but not when reading on', () => {
    const dir = { name: 'd', error: 'sed: read error on d: Is a directory\n', code: 4, fatal: true }
    const one = { name: 'f', text: 'one\ntwo\n' }
    const last = run('$p', [one, dir], { suppress: true })
    expect([last.stdout, last.exitCode]).toEqual(['two\n', 0])
    const after = run('$p', [one, dir, { name: 'g', text: 'x\n' }], { suppress: true })
    expect([after.stdout, after.exitCode]).toEqual(['x\n', 0])
    const next = run('n', [one, dir])
    expect([next.stdout, next.stderr, next.exitCode]).toEqual(['one\ntwo\n', dir.error, 4])
    const separate = run('$p', [one, dir], { suppress: true, separate: true })
    expect([separate.stdout, separate.exitCode]).toEqual(['two\n', 4])
  })

  it('reads r files anew after setFiles, R files once', () => {
    const machine = new SedMachine(
      compileScript([
        { kind: 'expr', text: '1r /r' },
        { kind: 'expr', text: '1R /q' },
      ]),
      {
        suppress: false,
        separate: true,
        lineLength: 70,
        files: new Map([['/r', { text: 'old\n' }]]),
        readerFiles: new Map([['/q', { text: 'Q1\nQ2\n' }]]),
      },
    )
    expect(machine.process([{ name: 'a', text: 'a\n' }], false)).toBe('a\nold\nQ1\n')
    machine.setFiles(new Map([['/r', { text: 'new\n' }]]))
    expect(machine.process([{ name: 'b', text: 'b\n' }], false)).toBe('b\nnew\nQ1\n')
  })

  it('stops at a read error', () => {
    const dir = { name: 'd', error: 'sed: read error on d: Is a directory\n', code: 4, fatal: true }
    const r = run('p', [{ name: 'f', text: 'a\n' }, dir, { name: 'g', text: 'b\n' }], {
      suppress: true,
    })
    expect(r.stdout).toBe('a\n')
    expect(r.exitCode).toBe(4)
  })

  it('refuses the removed L as GNU 4.9 does when it runs', () => {
    const r = run('L', 'a\n')
    expect(r.stderr).toBe('sed: INTERNAL ERROR: Bad cmd L\n')
    expect(r.exitCode).toBe(4)
  })
})

describe('sed regex meaning (GNU sed 4.9)', () => {
  it('converts \\d \\o \\x \\t \\n \\cX before regcomp, in both syntaxes', () => {
    expect(sed('s/\\d065/X/', 'A\n')).toBe('X\n')
    expect(sedE('s/\\d065/X/', 'A\n')).toBe('X\n')
    expect(sed('s/\\o101/X/', 'A\n')).toBe('X\n')
    expect(sedE('s/\\x41/X/', 'x41 A\n')).toBe('x41 X\n')
    expect(sedE('s/\\t/X/', 'a\tb t\n')).toBe('aXb t\n')
    expect(sed('s/\\cA/X/', 'a\x01b\n')).toBe('aXb\n')
    expect(sed('N;s/[\\n]/X/', 'a\nb\n')).toBe('aXb\n')
    expect(sed('s/[\\t]/X/', 'a\tb\n')).toBe('aXb\n')
  })

  it('reads \\d with no digits as d, and what \\x made as syntax', () => {
    expect(sedE('s/\\d/X/', 'd 7\n')).toBe('X 7\n')
    expect(sedE('s/\\d+/<&>/g', 'abc 123 x45\n')).toBe('abc 123 x45\n')
    expect(sed('s/a\\x2eb/X/g', 'a.b axb\n')).toBe('X X\n')
    expect(sed('s/a\\x2ab/X/g', 'a*b aab\n')).toBe('a*X X\n')
  })

  it('keeps GNU operators and POSIX brackets', () => {
    expect(sedE('s/\\<w/X/g', 'word sword\n')).toBe('Xord sword\n')
    expect(sedE('s/\\w+/X/g', 'a_b c\n')).toBe('X X\n')
    expect(sedE('s/a\\+/X/', 'a+b aab\n')).toBe('Xb aab\n')
    expect(sed('s/a\\+/X/', 'a+b aab\n')).toBe('X+b aab\n')
    expect(sed('s/a|b/X/', 'a|b\n')).toBe('X\n')
    expect(sedE('s/a|b/X/g', 'a|b\n')).toBe('X|X\n')
    expect(sed('s/[\\.]/X/g', 'a.b\\\n')).toBe('aXbX\n')
    expect(sed('s/*a/x/', 'a\n')).toBe('a\n')
    expect(sed('s/a{x}/y/', 'a{x}\n')).toBe('y\n')
    expect(sedE('s/a$b/X/', 'ab\n')).toBe('ab\n')
    expect(sed('s/a^b/X/', 'a^b\n')).toBe('X\n')
  })

  it('lets . and [^x] match a newline, except under M', () => {
    expect(sed('N;s/a.b/X/', 'a\nb\n')).toBe('X\n')
    expect(sed('N;s/a[^x]b/X/', 'a\nb\n')).toBe('X\n')
    expect(sed('N;s/a.b/X/M', 'a\nb\n')).toBe('a\nb\n')
    expect(sed('N;s/a$/X/M', 'a\nb\n')).toBe('X\nb\n')
    expect(sed('N;s/a$/X/', 'a\nb\n')).toBe('a\nb\n')
    expect(sed('N;s/^/X/Mg', 'a\nb\n')).toBe('Xa\nXb\n')
  })
})
