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
import { blockEnd, delimiterBreak, lineTerminators, relayout, wordBreaks } from './relayout.ts'
import type { Terminator } from './types.ts'

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

function relaid(command: string): string | null {
  return relayout(root(command), command)
}

function terminators(line: string, after: string): Terminator[] {
  const start = line.indexOf(after) + after.length
  return lineTerminators(line, start, line.length)
}

describe('delimiterBreak', () => {
  it.each([
    ['EOF', null],
    ['EOF;', 3],
    ['EOF;echo', 3],
    ['EOF>out', 3],
    ['EOF|wc', 3],
    ['EOF&&echo', 3],
    ['EOF)', 3],
    ["'EOF'", null],
    ["'EOF;'", null],
    ['"EOF;"', null],
    ['"E\\";F"', null],
    ["E'O;'F;", 6],
    ['EO\\;F;', 5],
    ["$'EO;F';", 7],
    [';EOF', null],
  ])('%s', (token, expected) => {
    expect(delimiterBreak(token)).toBe(expected)
  })
})

describe('wordBreaks', () => {
  it('reports where the blank goes', () => {
    expect(wordBreaks(root('cat <<EOF; echo x\nhi\nEOF\n'))).toEqual([9])
  })

  it('is empty for a whole delimiter', () => {
    expect(wordBreaks(root('cat <<EOF\nhi\nEOF\n'))).toEqual([])
    expect(wordBreaks(root("cat <<'EOF'; echo x\nhi\nEOF\n"))).toEqual([])
  })
})

describe('lineTerminators', () => {
  it('resumes past a semicolon', () => {
    expect(terminators('cat <<EOF ; echo x', 'EOF')).toEqual([{ start: 10, resume: 11 }])
  })

  it.each(['cat <<EOF ;; esac', 'cat <<EOF ;& esac', 'cat <<EOF ;;& esac', 'cat <<EOF ) '])(
    'keeps %s whole',
    (line) => {
      expect(terminators(line, 'EOF')).toEqual([{ start: 10, resume: 10 }])
    },
  )

  it('reads kept terminators longest first', () => {
    expect(terminators('cat <<EOF ;;& x; y', 'EOF').map((t) => t.start)).toEqual([10, 15])
  })

  it('lets quotes, constructs and comments hide their terminators', () => {
    expect(terminators('cat <<EOF \'a;b\' "c;d" $(e;f) ${g;h} <(i;j) `k;l`', 'EOF')).toEqual([])
    expect(terminators('cat <<EOF # a; b', 'EOF')).toEqual([])
    expect(terminators('cat <<EOF a\\;b; c', 'EOF')).toEqual([{ start: 14, resume: 15 }])
  })

  it('moves case patterns and paren groups whole', () => {
    const line = 'cat <<EOF; case y in y) echo;; esac; (a; b); ((i++)); z'
    expect(terminators(line, 'EOF').map((t) => t.start)).toEqual([
      line.indexOf('; case'),
      line.indexOf(';; esac'),
      line.indexOf('; (a'),
      line.indexOf('; ((i'),
      line.indexOf('; z'),
    ])
  })

  it('ends the search at an unclosed quote', () => {
    expect(terminators("cat <<EOF 'a; b", 'EOF')).toEqual([])
  })
})

describe('relayout', () => {
  it('moves a semicolon tail past the body', () => {
    expect(relaid('cat <<EOF ; echo x\nhi\nEOF\n')).toBe('cat <<EOF \nhi\nEOF\n echo x\n')
  })

  it("lays a line's bodies innermost-first", () => {
    expect(relaid('cat <<A && cat <<B\na\nA\nb\nB\n')).toBe('cat <<A && cat <<B\nb\nB\na\nA\n')
    expect(relaid('cat <<A | cat <<B >o && cat <<C\na\nA\nb\nB\nc\nC\n')).toBe(
      'cat <<A | cat <<B >o && cat <<C\nc\nC\nb\nB\na\nA\n',
    )
  })

  it("keeps each segment's bodies with it", () => {
    expect(relaid('cat <<A ; cat <<B ; echo c\na\nA\nb\nB\n')).toBe(
      'cat <<A \na\nA\n cat <<B \nb\nB\n echo c\n',
    )
    expect(relaid('cat <<A && cat <<B ; echo c\na\nA\nb\nB\n')).toBe(
      'cat <<A && cat <<B \nb\nB\na\nA\n echo c\n',
    )
  })

  it('cuts only at the first terminator after an operator', () => {
    expect(relaid('true; cat <<EOF ; echo x; echo y\nhi\nEOF\n')).toBe(
      'true; cat <<EOF \nhi\nEOF\n echo x; echo y\n',
    )
  })

  it('keeps case and paren terminators whole', () => {
    expect(relaid('(cat <<EOF )\nhi\nEOF\n')).toBe('(cat <<EOF \nhi\nEOF\n)\n')
    expect(relaid('case x in x) cat <<EOF ;; esac\nhi\nEOF\n')).toBe(
      'case x in x) cat <<EOF \nhi\nEOF\n;; esac\n',
    )
  })

  it('moves a comment with the tail', () => {
    expect(relaid('cat <<EOF ; # a; b\nhi\nEOF\n')).toBe('cat <<EOF \nhi\nEOF\n # a; b\n')
  })

  it('leaves a plain heredoc alone', () => {
    expect(relaid('cat <<EOF\nhi\nEOF\n')).toBeNull()
    expect(relaid('cat <<EOF && echo x\nhi\nEOF\n')).toBeNull()
    expect(relaid('cat <<EOF\nhi\nEOF\necho x\n')).toBeNull()
  })

  it('leaves an unterminated body alone', () => {
    expect(relaid('cat <<EOF ; echo x\nhi\n')).toBeNull()
  })

  it('adds the newline a last terminator lacks', () => {
    expect(relaid('cat <<EOF ; echo x\nhi\nEOF')).toBe('cat <<EOF \nhi\nEOF\n echo x\n')
  })

  it('keeps the lines after the bodies', () => {
    expect(relaid('cat <<A ; echo x\na\nA\necho y\n')).toBe('cat <<A \na\nA\n echo x\necho y\n')
  })

  it('handles every operator line', () => {
    expect(relaid('cat <<A ; echo x\na\nA\ncat <<B ; echo y\nb\nB\n')).toBe(
      'cat <<A \na\nA\n echo x\ncat <<B \nb\nB\n echo y\n',
    )
  })

  it("keeps the bodies' leading empty lines", () => {
    expect(relaid('cat <<A && cat <<B\n\na\nA\n\nb\nB\n')).toBe(
      'cat <<A && cat <<B\n\nb\nB\n\na\nA\n',
    )
  })
})

describe('blockEnd', () => {
  it('runs past the terminator line', () => {
    expect(blockEnd('cat <<A\na\nA\nx\n', [8, 10])).toBe(12)
    expect(blockEnd('cat <<A\na\nA', [8, 10])).toBe(11)
  })
})
