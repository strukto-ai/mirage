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
import { heredocBodies, nextLine, terminatorLine } from './body.ts'
import { cleanDelimiter } from './delimiter.ts'
import type { HeredocOperator } from './types.ts'

function operator(command: string, token: string, dash = false): HeredocOperator {
  const arrow = dash ? '<<-' : '<<'
  const wordStart = command.indexOf(arrow + token) + arrow.length
  return {
    wordStart,
    wordEnd: wordStart + token.length,
    delimiter: cleanDelimiter(token),
    allowsIndent: dash,
  }
}

function bodies(
  command: string,
  tokens: string[],
  dash = false,
  nested = false,
): ([number, number] | null)[] {
  return heredocBodies(
    command,
    tokens.map((token) => operator(command, token, dash)),
    nested,
  )
}

describe('terminatorLine', () => {
  it('is the first line equal to the delimiter', () => {
    expect(terminatorLine('body\nEOF\nEOF\n', 0, 'EOF', false)).toBe(5)
  })

  it('accepts a terminator without a trailing newline', () => {
    expect(terminatorLine('body\nEOF', 0, 'EOF', false)).toBe(5)
  })

  it('strips tabs but not spaces under <<-', () => {
    expect(terminatorLine('\tbody\n\tEOF\n', 0, 'EOF', true)).toBe(6)
    expect(terminatorLine('  body\n  EOF\n', 0, 'EOF', true)).toBeNull()
  })

  it('requires the whole line', () => {
    expect(terminatorLine('EOFX\nEOF\n', 0, 'EOF', false)).toBe(5)
  })

  it('is null when missing', () => {
    expect(terminatorLine('body\nmore\n', 0, 'EOF', false)).toBeNull()
  })
})

describe('nextLine', () => {
  it('is the offset after the newline, or null on the last line', () => {
    expect(nextLine('a\nb', 0)).toBe(2)
    expect(nextLine('a\nb', 2)).toBeNull()
  })
})

describe('heredocBodies', () => {
  it('spans the lines between the operator line and the terminator', () => {
    expect(bodies('cat <<EOF\nbody\nEOF\n', ['EOF'])).toEqual([[10, 15]])
  })

  it('ends at a terminator without a trailing newline', () => {
    expect(bodies('cat <<EOF\nbody\nEOF', ['EOF'])).toEqual([[10, 15]])
  })

  it('starts after a pipeline on the operator line', () => {
    const cmd = 'cat <<EOF | tr a-z A-Z\nbody\nEOF\n'
    expect(bodies(cmd, ['EOF'])).toEqual([[cmd.indexOf('body'), cmd.lastIndexOf('EOF')]])
  })

  it('starts after a continued operator line', () => {
    const cmd = 'cat <<EOF \\\n| tr a-z A-Z\nbody\nEOF\n'
    expect(bodies(cmd, ['EOF'])).toEqual([[cmd.indexOf('body'), cmd.lastIndexOf('EOF')]])
  })

  it('matches the unquoted delimiter', () => {
    const cmd = "cat <<EN'D'\nbody\nEND\n"
    expect(bodies(cmd, ["EN'D'"])).toEqual([[cmd.indexOf('body'), cmd.lastIndexOf('END')]])
  })

  it('matches an escaped double-quoted delimiter', () => {
    const cmd = 'cat <<"E\\$F"\nbody\nE$F\n'
    expect(bodies(cmd, ['"E\\$F"'])).toEqual([[cmd.indexOf('body'), cmd.lastIndexOf('E$F')]])
  })

  it('allows a tab-indented terminator under <<-', () => {
    const cmd = 'cat <<-EOF\n\tbody\n\tEOF\n'
    expect(bodies(cmd, ['EOF'], true)).toEqual([[cmd.indexOf('\tbody'), cmd.indexOf('\tEOF')]])
  })

  it('ignores a space-indented terminator under <<-', () => {
    // Only tabs are stripped, so the body runs on to the end.
    expect(bodies('cat <<-EOF\n  body\n  EOF\n', ['EOF'], true)).toEqual([[11, 24]])
  })

  it('runs an unterminated body to the end of the source', () => {
    // Bash reads it that way too, under a warning naming the delimiter.
    expect(bodies('cat <<EOF\nbody\nmore\n', ['EOF'])).toEqual([[10, 20]])
  })

  it('is null without a body line', () => {
    expect(bodies('cat <<EOF', ['EOF'])).toEqual([null])
  })

  it('starts the second body of a line after the first terminator', () => {
    expect(bodies('cat <<A <<B\none\nA\ntwo\nB\n', ['A', 'B'])).toEqual([
      [12, 16],
      [18, 22],
    ])
  })

  it('keeps the order given', () => {
    expect(bodies('cat <<A <<B\none\nA\ntwo\nB\n', ['B', 'A'])).toEqual([
      [18, 22],
      [12, 16],
    ])
  })

  it('never starts the second body when the first runs to the end', () => {
    expect(bodies('cat <<A <<B\none\ntwo\nB\n', ['A', 'B'])).toEqual([[12, 22], null])
  })

  it('gives the second body null when the first terminator ends the source', () => {
    expect(bodies('cat <<A <<B\none\nA', ['A', 'B'])).toEqual([[12, 16], null])
  })

  it('starts a later line after its own operator line', () => {
    const cmd = 'cat <<A <<B\none\nA\ntwo\nB\ncat <<C\nthree\nC\n'
    expect(bodies(cmd, ['A', 'B', 'C'])).toEqual([
      [12, 16],
      [18, 22],
      [cmd.indexOf('three'), cmd.lastIndexOf('C')],
    ])
  })

  it('treats an operator inside an earlier body as text', () => {
    const cmd = 'cat <<EOF\na <<X\nsecond\nEOF\n'
    expect(bodies(cmd, ['EOF', 'X'])).toEqual([
      [cmd.indexOf('a <<X'), cmd.lastIndexOf('EOF')],
      null,
    ])
  })

  // $'A' names A, so the first body ends at the A line and the second
  // operator still gets the lines after it.
  it('closes the body of a dollar-quoted delimiter', () => {
    const cmd = "cat <<$'A' <<'B'\nfirst\nA\n\\second\nB\n"
    expect(bodies(cmd, ["$'A'", "'B'"])).toEqual([
      [cmd.indexOf('first'), cmd.indexOf('A\n')],
      [cmd.indexOf('\\second'), cmd.lastIndexOf('B')],
    ])
  })

  it('closes the body of a continued delimiter', () => {
    // EO\<newline>F names EOF, so the body ends at the EOF line rather
    // than running to the end of the source.
    const cmd = 'cat <<EO\\\nF\nbody\nEOF\n'
    expect(bodies(cmd, ['EO\\\nF'])).toEqual([[cmd.indexOf('body'), cmd.indexOf('EOF\n')]])
  })

  it('starts the body after a multiline parameter expansion', () => {
    const cmd = 'cat <<EOF >${x:-\n/out}\nbody\nEOF\n'
    expect(bodies(cmd, ['EOF'])).toEqual([[cmd.indexOf('body'), cmd.indexOf('EOF\n')]])
  })
})

describe('heredocBodies: nested order, the layout the parser source keeps', () => {
  it("reads a line's bodies innermost-first", () => {
    const command = 'cat <<A && cat <<B\nb\nB\na\nA\n'
    const bStart = command.indexOf('\nb\n') + 1
    const aStart = command.indexOf('\na\n') + 1
    expect(bodies(command, ['A', 'B'], false, true)).toEqual([
      [aStart, aStart + 2],
      [bStart, bStart + 2],
    ])
  })

  it('agrees with bash order on a single heredoc per line', () => {
    const command = 'cat <<A\na\nA\ncat <<B\nb\nB\n'
    expect(bodies(command, ['A', 'B'], false, true)).toEqual(bodies(command, ['A', 'B']))
  })

  it('still treats an operator inside a body as text', () => {
    expect(bodies('cat <<A\ncat <<B\nA\nB\n', ['A', 'B'], false, true)).toEqual([[8, 16], null])
  })
})
