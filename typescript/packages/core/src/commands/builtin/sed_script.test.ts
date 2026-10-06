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
import { SedError, compileScript, type SedScriptPiece } from './sed_script.ts'

function compile(...exprs: string[]): ReturnType<typeof compileScript> {
  return compileScript(exprs.map((text) => ({ kind: 'expr', text })))
}

function refusal(pieces: SedScriptPiece[], extended = false): SedError {
  try {
    compileScript(pieces, extended)
  } catch (err) {
    if (err instanceof SedError) return err
    throw err
  }
  throw new Error('compiled')
}

function error(...exprs: string[]): string {
  return refusal(exprs.map((text) => ({ kind: 'expr', text }))).message
}

function cmds(...exprs: string[]): string {
  return compile(...exprs)
    .commands.map((c) => c.cmd)
    .join('')
}

describe('sed script blanks (GNU sed 4.9 compile.c)', () => {
  it.each([
    ['2 d'],
    ['2,3 p'],
    ['/b/ p'],
    ['2 s/b/X/'],
    ['2, 3p'],
    ['2 , 3 p'],
    ['2 !d'],
    ['2 ! d'],
    ['1 ~ 2 p'],
    ['/B/ I p'],
  ])('reads the address and command of %j', (expr) => {
    const [cmd] = compile(expr).commands
    expect(cmd?.a1).not.toBeNull()
    expect('dps').toContain(cmd?.cmd)
  })

  it('skips blanks and semicolons between commands and around braces', () => {
    expect(cmds(' ; ;2p ; ; 3p')).toBe('pp')
    expect(cmds('2,3 { p }')).toBe('{p}')
    expect(cmds('2{ p ; }')).toBe('{p}')
    expect(cmds('{p};{p}')).toBe('{p}{p}')
  })

  it('allows blanks and ; after s flags and y, but nothing else', () => {
    expect(cmds('s/b/X/ g')).toBe('s')
    expect(cmds('s/b/X/ ; p')).toBe('sp')
    expect(cmds('s/b/X/g p')).toBe('s')
    expect(cmds('y/b/X/ ;p')).toBe('yp')
    expect(error('y/b/X/p')).toBe('sed: -e expression #1, char 7: extra characters after command')
    expect(error('p x')).toBe('sed: -e expression #1, char 3: extra characters after command')
  })

  it('ends a comment at the newline and a command before it', () => {
    expect(cmds('2p # comment')).toBe('p')
    expect(cmds('2d#x')).toBe('d')
    expect(cmds('p;# c\np')).toBe('pp')
  })

  it('ends a label at a blank, ; } or #', () => {
    const program = compile(':a p')
    expect(program.commands.map((c) => [c.cmd, c.label])).toEqual([
      [':', 'a'],
      ['p', undefined],
    ])
    expect(cmds('2b x ; p ; :x')).toBe('bp:')
    expect(cmds('2{bx};p;:x')).toBe('{b}p:')
  })

  it('reads a file name to the end of the line', () => {
    const [r] = compile('1r /data/r.txt ;p').commands
    expect(r?.fname).toBe('/data/r.txt ;p')
    expect(compile('2r/data/r').commands[0]?.fname).toBe('/data/r')
    expect(compile('w /o ').wfiles).toEqual(['/o '])
  })

  it('reads l, q and Q numbers after blanks', () => {
    expect(compile('l 5').commands[0]?.intArg).toBe(5)
    expect(compile('l5').commands[0]?.intArg).toBe(5)
    expect(compile('l').commands[0]?.intArg).toBe(-1)
    expect(compile('2 q 5').commands[0]?.intArg).toBe(5)
    expect(error('2q x')).toBe('sed: -e expression #1, char 4: extra characters after command')
  })
})

describe('sed #n and v', () => {
  it('reads #n on the first line of the first piece as -n', () => {
    expect(compile('#n\np').noDefaultOutput).toBe(true)
    expect(compile('#nfoo').noDefaultOutput).toBe(true)
    expect(compile(' #n').noDefaultOutput).toBe(false)
    expect(compile('p', '#n').noDefaultOutput).toBe(false)
  })

  it('v accepts this version or an older one', () => {
    expect(cmds('v;p')).toBe('p')
    expect(cmds('v 4.2;p')).toBe('p')
    expect(error('v 9.0')).toBe('sed: -e expression #1, char 5: expected newer version of sed')
  })
})

describe('sed script errors (GNU sed 4.9 wording)', () => {
  it.each([
    ['2!!d', "char 3: multiple `!'s"],
    ['2! !d', "char 4: multiple `!'s"],
    ['2}', "char 2: unexpected `}'"],
    ['{p', "char 0: unmatched `{'"],
    ['2', 'char 1: missing command'],
    ['2 ', 'char 2: missing command'],
    ['2!', 'char 2: missing command'],
    ['k', "char 1: unknown command: `k'"],
    ['2 k', "char 3: unknown command: `k'"],
    [',p', "char 1: unknown command: `,'"],
    ['1,p', "char 3: unexpected `,'"],
    ['0p', 'char 2: invalid usage of line address 0'],
    ['0,2p', 'char 4: invalid usage of line address 0'],
    ['+1p', 'char 2: invalid usage of +N or ~N as first address'],
    ['s/a/b', "char 5: unterminated `s' command"],
    ['s/a/b/k', "char 7: unknown option to `s'"],
    ['/a', 'char 2: unterminated address regex'],
    [':', 'char 1: ":" lacks a label'],
    ['1:a', "char 2: : doesn't want any addresses"],
    ['1#x', "char 2: comments don't accept any addresses"],
    ['y/ab/c/', "char 7: strings for `y' command are different lengths"],
    ['y/ab/cd', "char 7: unterminated `y' command"],
    ['s/a/b/pp', "char 8: multiple `p' options to `s' command"],
    ['s/a/b/gg', "char 8: multiple `g' options to `s' command"],
    ['s/a/b/1 2', "char 9: multiple number options to `s' command"],
    ['s/o/O/0', "char 7: number option to `s' command may not be zero"],
    ['a', "char 1: expected \\ after `a', `c' or `i'"],
    ['1{a foo;}', "char 0: unmatched `{'"],
    ['1,2q', 'char 4: command only uses one address'],
    ['r', 'char 1: missing filename in r/R/w/W commands'],
    ['s/a/b/w', 'char 7: missing filename in r/R/w/W commands'],
    ['s/x/y/I;s//z/I', 'char 14: cannot specify modifiers on empty regexp'],
  ])('%j', (expr, why) => {
    expect(error(expr)).toBe(`sed: -e expression #1, ${why}`)
  })

  it('numbers the -e pieces and positions within each', () => {
    expect(error('p', 'k')).toBe("sed: -e expression #2, char 1: unknown command: `k'")
    expect(error('p', '2 k')).toBe("sed: -e expression #2, char 3: unknown command: `k'")
    expect(error('2', 'p')).toBe('sed: -e expression #1, char 1: missing command')
    expect(error('p', '{')).toBe("sed: -e expression #2, char 0: unmatched `{'")
  })

  it('names a script file and its line', () => {
    const file = (text: string): SedScriptPiece => ({ kind: 'file', text, name: '/s.sed' })
    expect(refusal([file('p\nk\n')]).message).toBe("sed: file /s.sed line 2: unknown command: `k'")
    expect(refusal([{ kind: 'expr', text: 'p' }, file('p\n\n 2 k\n')]).message).toBe(
      "sed: file /s.sed line 3: unknown command: `k'",
    )
    expect(refusal([file('2\n')]).message).toBe("sed: file /s.sed line 2: unknown command: `\n'")
    expect(refusal([file('p\n{\np\n')]).message).toBe("sed: file /s.sed line 2: unmatched `{'")
  })

  it('names the first byte of a multibyte command, counted in bytes', () => {
    expect(error('2 é')).toBe(
      `sed: -e expression #1, char 3: unknown command: \`${String.fromCharCode(0xdcc3)}'`,
    )
  })

  it('refuses e and s///e: mirage has no shell to run them', () => {
    expect(error('e echo hi')).toBe("sed: -e expression #1, char 1: `e' command not supported")
    expect(error('s/b/X/e')).toBe("sed: -e expression #1, char 7: `e' command not supported")
  })

  it('panics with exit 4 on a missing label', () => {
    const err = refusal([{ kind: 'expr', text: 'bfoo' }])
    expect(err.message).toBe("sed: can't find label for jump to `foo'")
    expect(err.exitCode).toBe(4)
  })

  it('keeps the w files it opened before the error', () => {
    const err = refusal([
      { kind: 'expr', text: 'w /o' },
      { kind: 'expr', text: 'k' },
    ])
    expect(err.wfiles).toEqual(['/o'])
  })
})

describe('sed delimiters and text', () => {
  it('drops a backslash before the delimiter and keeps a bracket whole', () => {
    expect(compile('s|a\\|b|X|').commands[0]?.subst?.re?.pattern).toBe('a|b')
    expect(compile('s.a\\.b.X.').commands[0]?.subst?.re?.pattern).toBe('a.b')
    expect(compile('s/[/]/X/').commands[0]?.subst?.re?.pattern).toBe('[/]')
    expect(compile('s&a&[\\&]&').commands[0]?.subst?.replacement).toBe('[\\&]')
  })

  it('decodes y escapes', () => {
    const [y] = compile('y/ab\\//\\n\\tX/').commands
    expect(y?.ySrc).toEqual(['a', 'b', '/'])
    expect(y?.yDst).toEqual(['\n', '\t', 'X'])
  })

  it('continues a text left open on a backslash into the next piece', () => {
    const [a] = compile('a\\', 'foo\\', 'bar').commands
    expect(a?.text).toBe('foo\nbar\n')
    expect(compile('a\\').commands[0]?.text).toBeNull()
  })

  it('reads 0r as a prepend on line 1', () => {
    const [r] = compile('0r /r').commands
    expect(r?.a1).toEqual({ kind: 'num', n: 1 })
    expect(r?.prepend).toBe(true)
    expect(error('0,1r /r')).toBe('sed: -e expression #1, char 4: invalid usage of line address 0')
  })
})

describe('sed regex compilation (GNU sed 4.9 over glibc)', () => {
  const eerror = (expr: string): string => refusal([{ kind: 'expr', text: expr }], true).message

  it.each([
    ['s/\\(/x/', 'char 7: Unmatched ( or \\('],
    ['s/\\)/x/', 'char 7: Unmatched ) or \\)'],
    ['s/a\\{x\\}/y/', 'char 11: Invalid content of \\{\\}'],
    ['s/a\\{2/x/', 'char 9: Unmatched \\{'],
    ['s/a\\{3,1\\}/x/', 'char 13: Invalid content of \\{\\}'],
    ['/\\(/p', 'char 4: Unmatched ( or \\('],
    ['/\\(/Ip', 'char 5: Unmatched ( or \\('],
    ['s/\\(/x/Ig', 'char 9: Unmatched ( or \\('],
    ['s/\\(/x/;p', 'char 8: Unmatched ( or \\('],
    ['s/\\(/x/ ; p', 'char 9: Unmatched ( or \\('],
    ['s/[[:foo:]]/x/', 'char 14: Invalid character class name'],
    ['s/[z-a]/x/', 'char 10: Invalid range end'],
    ['s/\\x5c/X/', 'char 9: Trailing backslash'],
    ['s/\\(a\\)/\\2/', "char 11: invalid reference \\2 on `s' command's RHS"],
  ])('BRE %j', (expr, why) => {
    expect(error(expr)).toBe(`sed: -e expression #1, ${why}`)
  })

  it.each([
    ['s/(/x/', 'char 6: Unmatched ( or \\('],
    ['s/)/x/', 'char 6: Unmatched ) or \\)'],
    ['s/*a/x/', 'char 7: Invalid preceding regular expression'],
    ['s/a|*b/x/', 'char 9: Invalid preceding regular expression'],
    ['s/a{x}/y/', 'char 9: Invalid content of \\{\\}'],
    ['s/a{1/x/', 'char 8: Unmatched \\{'],
    ['s/(?<=id=)[0-9]+/X/', 'char 19: Invalid preceding regular expression'],
    ['s/a/\\1/', "char 7: invalid reference \\1 on `s' command's RHS"],
  ])('ERE %j', (expr, why) => {
    expect(eerror(expr)).toBe(`sed: -e expression #1, ${why}`)
  })

  it('reports the regex before a later piece is read', () => {
    expect(error('s/\\(/x/', 'k')).toBe('sed: -e expression #1, char 7: Unmatched ( or \\(')
    expect(error('p', 's/\\(/x/')).toBe('sed: -e expression #2, char 7: Unmatched ( or \\(')
  })

  it('panics on a class written without its outer brackets', () => {
    const err = refusal([{ kind: 'expr', text: 's/[:alpha:]/x/' }])
    expect(err.message).toBe('sed: character class syntax is [[:space:]], not [:space:]')
    expect(err.exitCode).toBe(4)
    expect(compile('s/[:]/x/').commands).toHaveLength(1)
    expect(compile('s/[[:alpha:]]/x/').commands).toHaveLength(1)
  })

  it('accepts what glibc accepts', () => {
    expect(compile('s/*a/x/', 's/a{x}/y/', 's/a|b/X/').commands).toHaveLength(3)
    expect(
      compileScript([{ kind: 'expr', text: 's/a**/x/;s/a{,1}b/X/;s/()/x/' }], true).commands,
    ).toHaveLength(3)
  })
})

describe('a UTF-8 script', () => {
  it('reads characters', () => {
    const program = compileScript(
      [{ kind: 'expr', text: 'y/\u00e9/e/;s/\\xc3\\xa9/x/' }],
      false,
      true,
    )
    const [y, s] = program.commands
    expect([y?.ySrc, y?.yDst]).toEqual([['\u00e9'], ['e']])
    expect(s?.subst?.re?.source).toBe('\u00e9')
    expect(error('y/\u00e9/e/')).toBe(
      "sed: -e expression #1, char 7: strings for `y' command are different lengths",
    )
  })
})
