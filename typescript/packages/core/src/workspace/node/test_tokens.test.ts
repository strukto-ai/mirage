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

import { getText } from '../../shell/helpers.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { CondParser, type ExprToken, condLeaves, condTokens, flatTokens } from './test_tokens.ts'
import { parse } from '../../shell/parse/parse.ts'

// Mirrors python/tests/workspace/node/test_test_tokens.py.

function testNode(line: string): TSNodeLike {
  const stack = [parse(line)]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === NT.TEST_COMMAND) return node
    stack.push(...[...node.children].reverse())
  }
  throw new Error(`no test in ${JSON.stringify(line)}`)
}

function spelled(token: ExprToken): string {
  if (token.op !== null) return token.op
  return (token.negative ? '-' : '') + getText(token.operand)
}

describe('test tokens', () => {
  it('flat tokens are the words test is given', () => {
    // A `-N` tree-sitter splits is one operand again, as test reads it.
    const node = testNode('[ -e x -o ! 1 -lt -2 ]')
    expect(flatTokens(node).map(spelled)).toEqual(['-e', 'x', '-o', '!', '1', '-lt', '-2'])
  })

  it('cond leaves are each test in source order', () => {
    const node = testNode('[[ ! -e a && ( b == c* || -n d ) ]]')
    const leaves = condLeaves(new CondParser(condTokens(node)).parse())
    expect(leaves.map((leaf) => [leaf.kind, 'op' in leaf ? leaf.op : null])).toEqual([
      ['unary', '-e'],
      ['binary', '=='],
      ['unary', '-n'],
    ])
  })
})
