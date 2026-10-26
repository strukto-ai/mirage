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
import { parseShell } from '../../../rs/shell.ts'
import type { ShellNode } from '../../types.ts'
import { heredocOperators } from './shield.ts'

function root(command: string): ShellNode {
  return parseShell(command).rootNode
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

  it('finds two on one line', () => {
    const operators = heredocOperators(root('cat <<A ; cat <<B\none\nA\ntwo\nB\n'))
    expect(operators.map((op) => op.delimiter)).toEqual(['A', 'B'])
  })
})
