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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { Language, type Node, Parser } from 'web-tree-sitter'
import {
  firstContentLine,
  heredocOperators,
  protectedSource,
  sameShape,
  terminatorLookalikes,
} from './shield.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: Parser

beforeAll(async () => {
  await Parser.init({ wasmBinary: engineWasm })
  const language = await Language.load(new Uint8Array(grammarWasm))
  parser = new Parser()
  parser.setLanguage(language)
})

function root(command: string): Node {
  const tree = parser.parse(command)
  if (tree === null) throw new Error('parse returned null')
  return tree.rootNode
}

// The (offset, replacement) pairs by which `after` differs from `before`.
function diff(before: string, after: string): [number, string][] {
  const out: [number, string][] = []
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) out.push([i, after[i] ?? ''])
  }
  return out
}

describe('heredocOperators', () => {
  it('reads the delimiter as bash does', () => {
    expect(heredocOperators(root("cat <<-'EOF'\n\tbody\n\tEOF\n"))).toEqual([
      { wordStart: 7, wordEnd: 12, delimiter: 'EOF', allowsIndent: true },
    ])
  })

  it('lists operators in source order', () => {
    const operators = heredocOperators(root('cat <<A\none\nA\ncat <<B\ntwo\nB\n'))
    expect(operators.map((op) => op.delimiter)).toEqual(['A', 'B'])
  })

  it('finds a start token inside an error', () => {
    // Two heredocs on one line are beyond the grammar, but both start
    // tokens survive the error.
    const operators = heredocOperators(root('cat <<A ; cat <<B\none\nA\ntwo\nB\n'))
    expect(operators.map((op) => op.delimiter)).toEqual(['A', 'B'])
  })
})

describe('firstContentLine', () => {
  it('skips empty lines', () => {
    expect(firstContentLine('\n\nfoo\n', 0, 6)).toBe(2)
  })

  it('counts a blank line as content', () => {
    expect(firstContentLine('  \nfoo\n', 0, 7)).toBe(0)
  })

  it('is null for empty lines only', () => {
    expect(firstContentLine('\n\n', 0, 2)).toBeNull()
  })
})

describe('terminatorLookalikes', () => {
  it('names one character per such line', () => {
    const text = 'EOFX\nhi\n EOF\n\tEOF;\nEOF EOF\n'
    expect(terminatorLookalikes(text, [0, text.length], 'EOF')).toEqual([
      0,
      text.indexOf(' EOF') + 1,
      text.indexOf('\tEOF;') + 1,
      text.indexOf('EOF EOF'),
    ])
  })

  it('passes over expansion characters', () => {
    expect(terminatorLookalikes('$X;\nhi\n', [0, 7], '$X')).toEqual([1])
    expect(terminatorLookalikes('$$\n', [0, 3], '$')).toEqual([])
  })

  it('stays inside the span', () => {
    expect(terminatorLookalikes('hi\nEOF\n', [0, 3], 'EOF')).toEqual([])
  })
})

describe('protectedSource', () => {
  it('is null when the body lexes already', () => {
    const cmd = 'cat <<EOF\nfirst\nsecond\nEOF\n'
    expect(protectedSource(cmd, root(cmd))).toBeNull()
  })

  it('masks a leading backslash', () => {
    const cmd = "cat <<'EOF'\n\\first\nsecond\nEOF\n"
    const out = protectedSource(cmd, root(cmd))
    expect(out).not.toBeNull()
    expect(diff(cmd, out ?? '')).toEqual([[cmd.indexOf('\\first'), 'x']])
  })

  it('masks the escaped partner too', () => {
    const cmd = 'cat <<EOF\n\\$v\nsecond\nEOF\n'
    const out = protectedSource(cmd, root(cmd))
    const at = cmd.indexOf('\\$v')
    expect(diff(cmd, out ?? '')).toEqual([
      [at, 'x'],
      [at + 1, 'x'],
    ])
  })

  it('masks leading indentation', () => {
    const cmd = "cat <<'EOF'\n  first\nsecond\nEOF\n"
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([[cmd.indexOf('  first'), 'x']])
  })

  it('skips empty lines before the first content line', () => {
    const cmd = "cat <<'EOF'\n\n\\first\nsecond\nEOF\n"
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([[cmd.indexOf('\\first'), 'x']])
  })

  it('leaves leading empty lines to bodyPrefix', () => {
    const cmd = 'cat <<EOF\n\nfoo\nEOF\n'
    expect(protectedSource(cmd, root(cmd))).toBeNull()
  })

  it("avoids the delimiter's first letter", () => {
    const cmd = 'cat <<xfirst\n\\first\nsecond\nxfirst\n'
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([[cmd.indexOf('\\first'), 'y']])
  })

  it('handles every heredoc of a line list', () => {
    const cmd = 'cat <<A\n\\one\nA\ncat <<B\n\\two\nB\n'
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([
      [cmd.indexOf('\\one'), 'x'],
      [cmd.indexOf('\\two'), 'x'],
    ])
  })

  it('shields both bodies of one operator line', () => {
    // Laid out as the parser's source keeps two heredocs on one line:
    // innermost-first (see relayout), so B's body precedes A's.
    const cmd = 'cat <<A && cat <<B\n\\two\nB\n\\one\nA\n'
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([
      [cmd.indexOf('\\two'), 'x'],
      [cmd.indexOf('\\one'), 'x'],
    ])
  })

  it('shields an escaped double-quoted delimiter', () => {
    const cmd = 'cat <<"E\\$F"\n\\first\nE$F\n'
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([[cmd.indexOf('\\first'), 'x']])
  })

  it('ignores an operator inside a body', () => {
    // The swallowed first line spells `<<X`; body text is not syntax.
    const cmd = 'cat <<EOF\n\\a <<X\nsecond\nEOF\n'
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([[cmd.indexOf('\\a'), 'x']])
  })

  it('masks the leading tab under <<-', () => {
    const cmd = "cat <<-'EOF'\n\t\\first\n\tsecond\n\tEOF\n"
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([[cmd.indexOf('\t\\first'), 'x']])
  })

  it('masks an unterminated body too', () => {
    // Bash reads the body to the end of the input, so the shield does;
    // the masked copy still lacks heredoc_end, and parseProtected keeps
    // the plain tree for it.
    const cmd = 'cat <<EOF\n\\first\nsecond\n'
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([[cmd.indexOf('\\first'), 'x']])
  })

  it('masks a line that only opens with the delimiter', () => {
    // The scanner compares a line's first characters with the delimiter
    // and stops there, so each of these would end a body bash reads on.
    const cmd = 'cat <<EOF\nhi\nEOFX\nEOF;\n EOF\nEOF\n'
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([
      [cmd.indexOf('EOFX'), 'x'],
      [cmd.indexOf('EOF;'), 'x'],
      [cmd.indexOf(' EOF') + 1, 'x'],
    ])
  })

  it('masks a lookalike under <<-', () => {
    // The first line's tab is masked as before; the lookalikes join it.
    const cmd = 'cat <<-EOF\n\thi\n\tEOFX\n  EOF\n\tEOF\n'
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([
      [cmd.indexOf('\thi'), 'x'],
      [cmd.indexOf('\tEOFX') + 1, 'x'],
      [cmd.indexOf('  EOF') + 2, 'x'],
    ])
  })

  it('keeps an expansion opening a lookalike', () => {
    const cmd = 'cat <<$X\n$X;\nhi\n$X\n'
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([[cmd.indexOf('$X;') + 1, 'x']])
  })

  it('writes the alternate letter over the filler', () => {
    const cmd = 'cat <<xyz\nxyz1\nxyz\n'
    const out = protectedSource(cmd, root(cmd))
    expect(diff(cmd, out ?? '')).toEqual([[cmd.indexOf('xyz1'), 'y']])
  })
})

describe('sameShape', () => {
  it('is true for equal parses', () => {
    expect(sameShape(root('echo a | grep b'), root('echo a | grep b'))).toBe(true)
  })

  it('is false for a different tree', () => {
    expect(sameShape(root('echo a | grep b'), root('echo a; grep b'))).toBe(false)
  })

  it('is false when a span moves', () => {
    expect(sameShape(root('echo ab'), root('echo abc'))).toBe(false)
  })
})
