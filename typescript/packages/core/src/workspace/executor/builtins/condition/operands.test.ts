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

import type { ValueType } from '../../../../commands/spec/types.ts'
import { fileOperands } from './operands.ts'

// Mirrors python/tests/workspace/executor/builtins/condition/test_operands.py.

describe('fileOperands', () => {
  it.each<[string, string[], (ValueType | null)[]]>([
    ['test', ['-e', 'x'], [null, 'path']],
    ['test', ['-e', '-o', 'yes'], [null, null, null]],
    ['test', ['-e', '-a', 'x'], [null, null, null]],
    ['test', ['-f', '-o', '-e', 'x'], [null, null, null, 'path']],
    ['test', ['!', '-e', 'x'], [null, null, 'path']],
    ['test', ['-e', '=', 'x'], [null, null, null]],
    ['test', ['a', '-nt', 'b'], ['path', null, 'path']],
    ['[', ['-e', 'x', ']'], [null, 'path', null]],
    ['[[', ['-e', '-o'], [null, 'path']],
  ])('%s %j reads its files as test does', (name, words, kinds) => {
    // The gate reads a test's files off the evaluator's own reading, so
    // `-o` after `-e` joins two strings for both, and names no file.
    expect(fileOperands(name, words)).toEqual(kinds)
  })
})
