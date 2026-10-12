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

import type { TSNodeLike } from '../../shell/types.ts'
import { commandNodes } from './facts.ts'

// Mirrors python/tests/runtime/routing/test_facts.py.

function word(type: string, text: string): TSNodeLike {
  return { type, text, children: [], namedChildren: [] }
}

function command(...words: string[]): TSNodeLike {
  const children = words.map((w, i) => word(i === 0 ? 'command_name' : 'word', w))
  return { type: 'command', text: words.join(' '), children, namedChildren: children }
}

describe('commandNodes', () => {
  it('walks nested commands in source order', () => {
    const b = command('b')
    const substitution: TSNodeLike = {
      type: 'command_substitution',
      text: '$(b)',
      children: [b],
      namedChildren: [b],
    }
    const a: TSNodeLike = {
      type: 'command',
      text: 'a $(b)',
      children: [word('command_name', 'a'), substitution],
      namedChildren: [word('command_name', 'a'), substitution],
    }
    const c = command('c')
    const root: TSNodeLike = {
      type: 'program',
      text: 'a $(b) | c',
      children: [a, c],
      namedChildren: [a, c],
    }
    expect(commandNodes(root).map((n) => n.text)).toEqual(['a $(b)', 'b', 'c'])
  })
})
