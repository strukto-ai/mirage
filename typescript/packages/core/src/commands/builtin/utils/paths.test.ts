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

import { PathSpec } from '../../../types.ts'
import { hasUnresolvedGlob } from './paths.ts'

function concretePath(): PathSpec {
  return new PathSpec({
    virtual: '/public/tables/books/rows.jsonl',
    directory: '/public/tables/books/',
    vfsPath: 'public/tables/books/rows.jsonl',
    resolved: true,
  })
}

function globPath(): PathSpec {
  return new PathSpec({
    virtual: '/public/tables/*/rows.jsonl',
    directory: '/public/tables/',
    vfsPath: 'public/tables/*/rows.jsonl',
    pattern: 'rows.jsonl',
    resolved: false,
  })
}

describe('hasUnresolvedGlob', () => {
  it('is false for concrete operands', () => {
    expect(hasUnresolvedGlob([concretePath()])).toBe(false)
  })

  it('is false for no operands', () => {
    expect(hasUnresolvedGlob([])).toBe(false)
  })

  it('is true when any operand still carries a pattern', () => {
    expect(hasUnresolvedGlob([concretePath(), globPath()])).toBe(true)
  })
})
