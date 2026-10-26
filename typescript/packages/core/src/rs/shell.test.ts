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
    expect(tree.rootNode.hasError).toBe(true)
    expect(tree.error).toEqual({ index: 13, message: 'syntax error: unexpected end of file' })
    expect(parseShell('echo a; fi').error).toEqual({
      index: 8,
      message: "syntax error near unexpected token `fi'",
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
