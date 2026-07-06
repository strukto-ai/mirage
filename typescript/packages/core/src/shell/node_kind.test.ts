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
import { NodeKind, nodeKind } from './node_kind.ts'
import { createShellParser, type ShellParser } from './parse.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

// One snippet per statement kind. The map must cover the full enum
// (asserted below), so adding a NodeKind without deciding how it
// classifies fails here before it can drift between the walkers.
const SNIPPETS: Record<NodeKind, string> = {
  [NodeKind.COMMENT]: '# a comment',
  [NodeKind.PROGRAM]: 'true',
  [NodeKind.COMMAND]: 'cat /data/a.txt',
  [NodeKind.PIPELINE]: 'cat /data/a.txt | wc -l',
  [NodeKind.LIST]: 'true && false',
  [NodeKind.REDIRECT]: 'cat /data/a.txt > /data/b.txt',
  [NodeKind.SUBSHELL]: '(true)',
  [NodeKind.COMPOUND]: '{ true; }',
  [NodeKind.IF]: 'if true; then false; fi',
  [NodeKind.FOR]: 'for i in 1 2; do true; done',
  [NodeKind.SELECT]: 'select x in a b; do true; done',
  [NodeKind.WHILE]: 'while true; do false; done',
  [NodeKind.UNTIL]: 'until false; do true; done',
  [NodeKind.CASE]: 'case x in x) true;; esac',
  [NodeKind.FUNCTION_DEF]: 'f() { true; }',
  [NodeKind.DECLARATION]: 'export FOO=1',
  [NodeKind.UNSET]: 'unset FOO',
  [NodeKind.TEST]: '[[ -n x ]]',
  [NodeKind.NEGATED]: '! true',
  [NodeKind.VAR_ASSIGN]: 'FOO=1',
  [NodeKind.UNSUPPORTED]: 'for ((i=0;i<2;i++)); do true; done',
}

function firstStatement(snippet: string) {
  const root = parser.parse(snippet)
  expect(root.type).toBe('program')
  const first = root.namedChildren[0]
  if (first === undefined) throw new Error('empty program')
  return first
}

describe('nodeKind', () => {
  it('snippets cover the full enum', () => {
    expect(new Set(Object.keys(SNIPPETS))).toEqual(new Set(Object.values(NodeKind)))
  })

  for (const kind of Object.values(NodeKind)) {
    it(`classifies ${kind}`, () => {
      const node =
        kind === NodeKind.PROGRAM ? parser.parse(SNIPPETS[kind]) : firstStatement(SNIPPETS[kind])
      expect(nodeKind(node)).toBe(kind)
    })
  }

  it('disambiguates select/for and until/while', () => {
    expect(nodeKind(firstStatement('select x in a; do true; done'))).toBe(NodeKind.SELECT)
    expect(nodeKind(firstStatement('for i in a; do true; done'))).toBe(NodeKind.FOR)
    expect(nodeKind(firstStatement('until false; do true; done'))).toBe(NodeKind.UNTIL)
    expect(nodeKind(firstStatement('while true; do false; done'))).toBe(NodeKind.WHILE)
  })
})
