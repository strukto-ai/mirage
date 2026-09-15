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

import { expect, it } from 'vitest'
import type { TSNodeLike } from '../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'

function substitution(root: TSNodeLike): TSNodeLike {
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    if (node.type === 'command_substitution') return node
    stack.push(...[...node.namedChildren].reverse())
  }
  throw new Error('no substitution')
}

it('restores heredoc syntax for nested evaluation', async () => {
  const parser = await getTestParser()
  const node = substitution(parser.parse('echo "$(cat <<EOF\nhello\nEOF\n)"'))
  expect(node.sourceText).toContain('<<EOF')
  expect(node.text).not.toContain('<<EOF')
})

it('keeps reader continuation removal in nested evaluation', async () => {
  const parser = await getTestParser()
  const node = substitution(parser.parse("cat <<EOF\n$(printf '%s' 'a\\\nb')\nEOF"))
  expect(node.sourceText).toBe("$(printf '%s' 'ab')")
})

it('keeps earlier nodes alive across subsequent parses', async () => {
  const parser = await getTestParser()
  const first = parser.parse('cat <<EOF\none\nEOF')
  parser.parse('cat <<EOF\ntwo\nEOF')
  expect(first.namedChildren[0]?.namedChildren.at(-1)?.heredoc?.body).toBe('one\n')
})
