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
import { MemoryExhausted } from './errors.ts'
import { checkMemory, lineMemoryLimit, runWithMemoryLimit } from './memory.ts'

describe('line memory limit', () => {
  it('caps nothing outside a line', () => {
    expect(lineMemoryLimit()).toBeNull()
    checkMemory(2 ** 40)
  })

  it('refuses an object past the line limit', async () => {
    const seen = await runWithMemoryLimit(10, async () => {
      await Promise.resolve()
      checkMemory(10)
      expect(() => {
        checkMemory(11)
      }).toThrow(MemoryExhausted)
      return lineMemoryLimit()
    })
    expect(seen).toBe(10)
    expect(lineMemoryLimit()).toBeNull()
  })

  it('caps nothing once lifted', async () => {
    await runWithMemoryLimit(null, () => {
      checkMemory(2 ** 40)
      return Promise.resolve()
    })
  })
})
