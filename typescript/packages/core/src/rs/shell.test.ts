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
import { parseShell, type ShellTreeNode } from './shell.ts'

// Mirrors Python's BASH.
const BASH: [string, string][] = [
  [
    'exec 0>f',
    '(program (redirected_statement body: (command name: (command_name (word))) redirect: (file_redirect descriptor: (file_descriptor) destination: (word))))',
  ],
  [
    'time a | b',
    '(program (timed_statement (pipeline (command name: (command_name (word))) (command name: (command_name (word))))))',
  ],
  [
    '! { a; }',
    '(program (negated_command (compound_statement (command name: (command_name (word))))))',
  ],
  [
    'echo $10',
    '(program (command name: (command_name (word)) argument: (concatenation (simple_expansion (variable_name)) (number))))',
  ],
]

function sexp(node: ShellTreeNode, field: string | null = null): string {
  const named = node.children.flatMap((child, i) =>
    child.isNamed ? [sexp(child, node.fieldNameForChild(i))] : [],
  )
  return `${field === null ? '' : `${field}: `}(${[node.type, ...named].join(' ')})`
}

describe('parseShell', () => {
  it.each(BASH)('reads as bash reads: %j', (line, want) => {
    const tree = parseShell(line)
    expect(tree.error).toBeNull()
    expect(sexp(tree.rootNode)).toBe(want)
  })

  it('reports a refused line in bash words', () => {
    const tree = parseShell('if true; then')
    expect(tree.error).toEqual({
      index: 13,
      message: 'mirage: syntax error: unexpected end of file\n',
      status: 2,
    })
    expect(parseShell('echo a; fi').error).toEqual({
      index: 8,
      message: "mirage: syntax error near 'fi'\n",
      status: 2,
    })
    // With extglob off a pattern group is no word.
    expect(parseShell('echo @(a)').error).toBeNull()
    expect(parseShell('echo @(a)', [], false).error).toEqual({
      index: 6,
      message: "mirage: syntax error near '('\n",
      status: 2,
    })
  })

  it('links nodes to their family', () => {
    const root = parseShell('a=1 echo hi > f').rootNode
    const statement = root.child(0)
    if (statement === null) throw new Error('no statement')
    const [command, redirect] = statement.children as [ShellTreeNode, ShellTreeNode]
    expect(statement.parent?.id).toBe(root.id)
    expect(root.parent).toBeNull()
    expect(command.nextSibling?.id).toBe(redirect.id)
    expect(redirect.previousSibling?.id).toBe(command.id)
    expect(redirect.nextSibling).toBeNull()
    expect(statement.childForFieldName('redirect')?.id).toBe(redirect.id)
    expect(statement.child(1)?.id).toBe(redirect.id)
    expect(statement.child(2)).toBeNull()
    expect(command.childForFieldName('name')?.text).toBe('echo')
    expect(command.namedChildren.map((node) => node.type)).toEqual([
      'variable_assignment',
      'command_name',
      'word',
    ])
    expect(command.fieldNameForChild(2)).toBe('argument')
  })

  it('counts offsets and columns in UTF-16 units', () => {
    const line = 'echo é💡 x'
    const word = parseShell(line).rootNode.child(0)?.child(2)
    expect(word?.startIndex).toBe(line.length - 1)
    expect(word?.startPosition).toEqual({ row: 0, column: line.length - 1 })
    expect(word?.text).toBe('x')
  })

  it('gives each tree its own ids', () => {
    const one = parseShell('a').rootNode
    const two = parseShell('a').rootNode
    expect(one.id).not.toBe(two.id)
    expect(one.children[0]?.id).toBe(one.children[0]?.id)
  })
})

describe('the text a tree reads', () => {
  it.each([
    // An odd-length trailing run ends in a live continuation.
    ['echo a\\', 'echo a'],
    ['echo a\\\\\\', 'echo a\\\\'],
    ['echo \\', 'echo '],
    // An even-length run is all escaped backslashes, so nothing goes.
    ['echo a\\\\', 'echo a\\\\'],
    ['echo a\\\\\\\\', 'echo a\\\\\\\\'],
    ['echo a', 'echo a'],
    ['echo a\\ b', 'echo a\\ b'],
    // Mid-line, the pair goes wherever the reader sees it.
    ['echo a\\\nb', 'echo ab'],
    ['echo "a\\\nb"', 'echo "ab"'],
    ['echo $\\\n{x} $((1\\\n+2))', 'echo ${x} $((1+2))'],
    ['ec\\\nho a', 'echo a'],
    ['echo a\\\\\nb', 'echo a\\\\\nb'],
    ['echo a\\\\\\\nb', 'echo a\\\\b'],
    // Single-quoted and ANSI-C text and comments keep theirs.
    ["echo 'a\\\nb'", "echo 'a\\\nb'"],
    ["echo $'a\\\nb'", "echo $'a\\\nb'"],
    ['echo a # c \\\necho b', 'echo a # c \\\necho b'],
    ['echo "$(echo \'u\\\nv\')"', 'echo "$(echo \'u\\\nv\')"'],
    ['echo "it\'s a\\\nb"', 'echo "it\'s ab"'],
  ])('drops the continuations of %j', (command, expected) => {
    expect(parseShell(command).source).toBe(expected)
  })

  it('keeps a quoted heredoc body whole', () => {
    const tree = parseShell("cat <<'E' | \\\ntr a b\na\\\nb\nE")
    expect(tree.source).toBe('cat <"a\\\\\nb\n" | tr a b\n')
    expect(tree.rootNode.sourceText).toBe("cat <<'E' | \\\ntr a b\na\\\nb\nE")
  })

  it('joins an unquoted heredoc body', () => {
    expect(parseShell('cat <<E | \\\ntr a b\na\\\nb $x\nE').source).toBe(
      'cat <"ab $x\n" | tr a b\n',
    )
  })

  it.each([
    ['continuation', 'echo A; \\\n fi'],
    ['expansion', 'echo /api/$c/$id.json; fi'],
    ['bang', '! echo A \\\n; fi'],
    ['time', 'time echo A \\\n; fi'],
    ['heredoc', 'cat <<E; fi\nbody\nE'],
  ])('points a %s node back into the line as typed', (_label, command) => {
    // The stray `fi` is where the parser refuses each line.
    const root = parseShell(command).rootNode
    const errors = root.children.filter((node) => node.type === 'ERROR')
    expect(errors).toHaveLength(1)
    expect(root.offsets[errors[0]?.startIndex ?? -1]).toBe(command.lastIndexOf('fi'))
  })
})
