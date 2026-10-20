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

import { flatShape } from './shape.ts'
import type { FlatNode } from './types.ts'

// Mirrors python/tests/workspace/executor/builtins/condition/test_shape.py.

describe('flatShape', () => {
  it.each<[string[], FlatNode]>([
    [[], null],
    [['x'], { kind: 'string', at: 0 }],
    [['!', '-e', 'x'], { kind: 'not', inner: { kind: 'unary', op: '-e', at: 2 } }],
    [
      ['-e', '-o', 'yes'],
      { kind: 'or', left: { kind: 'string', at: 0 }, right: { kind: 'string', at: 2 } },
    ],
    [
      ['-f', '-o', '-e', 'x'],
      { kind: 'or', left: { kind: 'string', at: 0 }, right: { kind: 'unary', op: '-e', at: 3 } },
    ],
    [['a', '-nt', 'b'], { kind: 'binary', left: 0, op: '-nt', right: 2 }],
    [['x', 'y'], { kind: 'fail', message: 'test: x: unary operator expected' }],
    [
      ['1', '-eq', 'x', '-a'],
      {
        kind: 'and',
        left: { kind: 'binary', left: 0, op: '-eq', right: 2 },
        right: { kind: 'fail', message: 'test: argument expected' },
      },
    ],
  ])('reads %j as test does', (words, reading) => {
    // A grammar error stands after the terms test evaluates before it.
    expect(flatShape('test', words)).toEqual(reading)
  })
})
