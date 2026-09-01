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
import { beforeAll, expect, it } from 'vitest'

import { INT_COMPARATORS } from '../../workspace/executor/builtins/condition/constants.ts'
import { ARITH_TEST_OPERATORS, DECLARING_NODES, TARGET_NAME_FIELDS } from './constants.ts'
import { createShellParser, type ShellParser } from './index.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

// The parse-side set may not drift from the comparators `[[` runs as
// arithmetic (condition/tree.ts); parse cannot import upward, so the
// spellings live twice and this pins them together.
it('arith test operators match the executor', () => {
  expect(ARITH_TEST_OPERATORS).toEqual(new Set(INT_COMPARATORS.keys()))
})

it('target name fields match the grammar', () => {
  const sources: Record<string, string> = {
    variable_assignment: 'X=1',
    for_statement: 'for X in a; do :; done',
  }
  for (const [nodeType, field] of Object.entries(TARGET_NAME_FIELDS)) {
    const node = parser.parse(sources[nodeType] ?? '').namedChildren[0]
    expect(node?.type).toBe(nodeType)
    expect(node?.childForFieldName(field)?.text).toBe('X')
  }
})

it('declaring nodes match the grammar', () => {
  const shapes = ['export X', 'unset X']
  const types = new Set(shapes.map((src) => parser.parse(src).namedChildren[0]?.type))
  expect(types).toEqual(DECLARING_NODES)
})
