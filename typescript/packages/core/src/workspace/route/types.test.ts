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
import { Consumer, SHELL_CONSUMERS, WordPolicy, wordPolicy } from './types.ts'

describe('wordPolicy', () => {
  it('shell consumers get the shell policy', () => {
    for (const consumer of SHELL_CONSUMERS) {
      expect(wordPolicy(consumer)).toBe(WordPolicy.SHELL)
    }
  })

  it('mount gets the mount policy', () => {
    expect(wordPolicy(Consumer.MOUNT)).toBe(WordPolicy.MOUNT)
  })

  it('unknown gets the mount policy', () => {
    // Unknown names keep patterns intact: nothing resolves their
    // words, the command fails before any backend I/O.
    expect(wordPolicy(Consumer.UNKNOWN)).toBe(WordPolicy.MOUNT)
  })

  it('every consumer has a policy', () => {
    for (const consumer of Object.values(Consumer)) {
      expect(Object.values(WordPolicy)).toContain(wordPolicy(consumer))
    }
  })
})
