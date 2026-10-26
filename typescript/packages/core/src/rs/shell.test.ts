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
import { Language, Parser, type Node } from 'web-tree-sitter'
import { parseShell, type ShellTreeNode } from './shell.ts'

const require = createRequire(import.meta.url)
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let grammar: Parser

beforeAll(async () => {
  await Parser.init()
  grammar = new Parser()
  grammar.setLanguage(await Language.load(grammarWasm))
})

// Lines both parsers read alike: tree-sitter-bash's shapes, spans and
// points, the grammar's quirks included. Mirrors Python's SAME.
const SAME = [
  'echo hi',
  'echo a > f b 2>&1 | tr a b && x=1 y=2',
  'a | b > f | c',
  '! a && b || c &',
  "echo \"a $b ${c} $(d) `e`\" 'f' $'g\\n'",
  'printf "%s" "$x $y" "$x  y" "$x "',
  'echo {1..3} {a,b} ] ]',
  'x=(1 2) a[i+1]=v declare -r y=1 z',
  'echo ${a:-two words} ${a#*/} ${a/x/ $f} ${#a[@]} ${!p*}',
  'echo $(( a + b * -c )) $[1] && (( i++, j-- ))',
  '[[ $x == a* && -f f ]] || [ ! -e g ]',
  'case $x in a|b) echo ab;; *.txt) ;& (c) echo c;; esac',
  'for i in 1 2; do echo $i; done; for ((i=0; i<3; i++)); do :; done',
  'f() { local v=$1; } # trailing',
  'while read -r l; do echo "$l"; done < f',
  'cat <<EOF | wc -l\nline $x\nEOF',
  "cat <<-'E'\n\tbody\n\tE",
  'echo héllo wörld 💡 | tr é e',
  'echo "日本 $x 😀"',
]

// Lines tree-sitter-bash misreads, as bash reads them. Mirrors Python's BASH.
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

type Canon = [string, boolean, string | null, number, number, string, string, boolean, Canon[]]

function canon(node: Node | ShellTreeNode, field: string | null = null): Canon {
  return [
    node.type,
    node.isNamed,
    field,
    node.startIndex,
    node.endIndex,
    `${String(node.startPosition.row)}:${String(node.startPosition.column)}`,
    `${String(node.endPosition.row)}:${String(node.endPosition.column)}`,
    node.isMissing,
    node.children.map((child, i) =>
      canon(child as Node & ShellTreeNode, node.fieldNameForChild(i)),
    ),
  ]
}

function sexp(node: ShellTreeNode, field: string | null = null): string {
  const named = node.children.flatMap((child, i) =>
    child.isNamed ? [sexp(child, node.fieldNameForChild(i))] : [],
  )
  return `${field === null ? '' : `${field}: `}(${[node.type, ...named].join(' ')})`
}

describe('parseShell', () => {
  it.each(SAME)('matches tree-sitter-bash: %j', (line) => {
    const want = grammar.parse(line)?.rootNode
    if (want === undefined) throw new Error(`tree-sitter-bash gave no tree for ${line}`)
    expect(want.hasError).toBe(false)
    expect(canon(parseShell(line).rootNode)).toEqual(canon(want))
  })

  it.each(BASH)('follows bash where the grammar misreads it: %j', (line, want) => {
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

  it('gives each tree its own ids', () => {
    const one = parseShell('a').rootNode
    const two = parseShell('a').rootNode
    expect(one.id).not.toBe(two.id)
    expect(one.children[0]?.id).toBe(one.children[0]?.id)
  })
})
