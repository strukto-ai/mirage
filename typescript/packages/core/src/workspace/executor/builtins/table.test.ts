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
import { ShellBuiltin } from '../../../shell/types.ts'
import { JOB_BUILTINS } from '../../lookup/index.ts'
import { BUILTINS } from './table.ts'

// Interpreters are general mount commands (commands/builtin/general),
// reserved in ShellBuiltin only so no CLI can take the name.
const INTERPRETERS = new Set(['python', 'python3', 'node', 'js'])

describe('the builtin table', () => {
  it('covers every executor-run builtin', () => {
    const expected = new Set<string>()
    for (const word of Object.values(ShellBuiltin)) {
      if (!JOB_BUILTINS.has(word) && !INTERPRETERS.has(word)) expected.add(word)
    }
    expect(new Set(BUILTINS.keys())).toEqual(expected)
  })

  it('aliases share a handler', () => {
    expect(BUILTINS.get('.')).toBe(BUILTINS.get('source'))
    expect(BUILTINS.get('sh')).toBe(BUILTINS.get('bash'))
    expect(BUILTINS.get('readarray')).toBe(BUILTINS.get('mapfile'))
    expect(BUILTINS.get('typeset')).toBe(BUILTINS.get('declare'))
    expect(BUILTINS.get('readonly')).toBe(BUILTINS.get('declare'))
    expect(BUILTINS.get('[')).toBe(BUILTINS.get('test'))
    expect(BUILTINS.get('[[')).toBe(BUILTINS.get('test'))
  })
})
