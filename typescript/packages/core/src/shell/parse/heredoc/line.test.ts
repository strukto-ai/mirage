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
import { operatorLineEnd, quoteEnd, reservedWord } from './line.ts'

function end(command: string, word = 'EOF'): number | null {
  return operatorLineEnd(command, command.indexOf(word) + word.length)
}

describe('operatorLineEnd', () => {
  it('ends at the first newline', () => {
    expect(end('cat <<EOF\nbody\nEOF\n')).toBe('cat <<EOF'.length)
  })

  it('runs past a pipeline', () => {
    const cmd = 'cat <<EOF | tr a-z A-Z\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf('\n'))
  })

  it('is not extended by a trailing pipe', () => {
    // Bash gathers the body at this newline and reads the rest of the
    // pipeline after the terminator.
    const cmd = 'cat <<EOF |\nbody\nEOF\ntr a-z A-Z\n'
    expect(end(cmd)).toBe(cmd.indexOf('\n'))
  })

  it('continues across a backslash newline', () => {
    const cmd = 'cat <<EOF \\\n| tr a-z A-Z\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf('A-Z\n') + 3)
  })

  it('lets a comment after a blank hide its quote', () => {
    const cmd = "cat <<EOF # don't\nbody\nEOF\n"
    expect(end(cmd)).toBe(cmd.indexOf("'t\n") + 2)
  })

  it.each([';', '|', '&&', '&', '(', ')', '<', '>'])(
    'lets a comment after %j hide its quote',
    (separator) => {
      const cmd = `cat <<EOF${separator}# don't\nbody\nEOF\n`
      expect(end(cmd)).toBe(cmd.indexOf("'t\n") + 2)
    },
  )

  it('does not read a hash inside a word as a comment', () => {
    const cmd = "cat <<EOF a#b'\nc'\nbody\nEOF\n"
    expect(end(cmd)).toBe(cmd.indexOf("c'\n") + 2)
  })

  it('does not read a hash after a dollar as a comment', () => {
    const cmd = "cat <<EOF $#'\nc'\nbody\nEOF\n"
    expect(end(cmd)).toBe(cmd.indexOf("c'\n") + 2)
  })

  it('runs a comment inside a substitution to its own newline', () => {
    const cmd = "cat <<EOF $(# don't\necho x)\nbody\nEOF\n"
    expect(end(cmd)).toBe(cmd.indexOf('x)\n') + 2)
  })

  it('lets an ANSI-C quote escape its apostrophe', () => {
    const cmd = "cat <<EOF | grep $'it\\'s'\nbody\nEOF\n"
    expect(end(cmd)).toBe(cmd.indexOf("s'\n") + 2)
  })

  it('does not end the line at a quoted newline', () => {
    const cmd = "cat <<EOF | tr 'a\nb' x\nbody\nEOF\n"
    expect(end(cmd)).toBe(cmd.indexOf(' x\n') + 2)
  })

  it('does not end the line inside a substitution', () => {
    const cmd = 'cat <<EOF | $(echo\ncat)\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf('cat)\n') + 4)
  })

  it('does not end at a newline inside a parameter expansion', () => {
    // Bash reads no body until the word holding the expansion is whole.
    const cmd = 'cat <<EOF >${x:-\n/out}\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf('/out}\n') + 5)
  })

  it('spans the newlines of nested parameter expansions', () => {
    const cmd = 'cat <<EOF >${x:-${y:-\n/out}}\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf('/out}}\n') + 6)
  })

  it('takes a hash inside a parameter expansion as text', () => {
    const cmd = 'cat <<EOF ${x:- #y\n}\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf('}\nbody') + 1)
  })

  it('still reads a comment in a substitution inside an expansion', () => {
    const cmd = 'cat <<EOF ${x:-$(: # c\n)}\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf(')}\n') + 2)
  })

  it('takes a closing brace with no expansion as ordinary text', () => {
    const cmd = 'cat <<EOF }\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf('\n'))
  })

  it('never ends after an unterminated parameter expansion', () => {
    expect(end('cat <<EOF >${x:-\nbody\nEOF\n')).toBeNull()
  })

  it('never ends after an unterminated quote', () => {
    expect(end("cat <<EOF | tr 'a\nbody\nEOF\n")).toBeNull()
  })

  it('never ends without a newline', () => {
    expect(end('cat <<EOF')).toBeNull()
  })

  // A `)` closing a case pattern closes no substitution, and a quote
  // inside one is the substitution's own.

  it('does not close a substitution at a case pattern paren', () => {
    const cmd = 'cat <<EOF $(case x in\nx)\n  :\n  ;;\nesac\n)\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf(')\nbody') + 1)
  })

  it('lets a parenthesized case pattern balance itself', () => {
    const cmd = 'cat <<EOF $(case x in\n(x)\n  :\n  ;;\nesac\n)\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf(')\nbody') + 1)
  })

  it('closes nested case statements one at a time', () => {
    const cmd =
      'cat <<EOF $(case x in\nx)\n  case y in\n  y) : ;;\n  esac\n  ;;\nesac\n)\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf(')\nbody') + 1)
  })

  it('closes a substitution holding case as an ordinary word', () => {
    const cmd = 'cat <<EOF $(grep case f)\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf('f)\n') + 2)
  })

  it('reads a case assignment as an ordinary word', () => {
    const cmd = 'cat <<EOF $(case=1; echo ok)\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf('ok)\n') + 3)
  })

  it('keeps the quotes of a substitution inside double quotes', () => {
    const cmd = 'cat <<EOF >"$( : "a\n  b"; echo /out)"\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf(')"\n') + 2)
  })

  it('keeps the quotes of a backtick inside double quotes', () => {
    const cmd = 'cat <<EOF >"`  : "a\n  b"; echo /out `"\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf('`"\n') + 2)
  })

  it('reads an apostrophe inside double quotes as ordinary', () => {
    const cmd = 'cat <<EOF >"/it\'s"\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf('"\nbody') + 1)
  })

  it('reads a paren inside double quotes as ordinary', () => {
    const cmd = 'cat <<EOF >"/out(1)"\nbody\nEOF\n'
    expect(end(cmd)).toBe(cmd.indexOf('"\nbody') + 1)
  })

  it('never ends after an unterminated case', () => {
    expect(end('cat <<EOF $(case x in\nbody\nEOF\n')).toBeNull()
  })
})

describe('reservedWord', () => {
  it('needs a command position', () => {
    expect(reservedWord('$(case x in', 2, 'case')).toBe(true)
    expect(reservedWord('$(: ; case x in', 6, 'case')).toBe(true)
    expect(reservedWord('$(grep case f', 7, 'case')).toBe(false)
  })

  it('needs the whole word', () => {
    expect(reservedWord('$(esacs', 2, 'esac')).toBe(false)
    expect(reservedWord('$(case=1', 2, 'case')).toBe(false)
  })
})

describe('quoteEnd', () => {
  it('skips an escaped double quote', () => {
    expect(quoteEnd('"a\\"b" c', 0)).toBe(6)
  })

  it('takes a backslash literally in single quotes', () => {
    expect(quoteEnd("'a\\' b", 0)).toBe(4)
  })

  it('honors ANSI-C escapes', () => {
    expect(quoteEnd("$'a\\'b' c", 1)).toBe(7)
  })

  it('is null when unterminated', () => {
    expect(quoteEnd('"abc', 0)).toBeNull()
  })
})
