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
import { MemoryBudget, checkMemory, memoryRoom, runWithMemory } from './memory.ts'

describe('memory budget', () => {
  it('caps nothing outside a workspace', () => {
    expect(memoryRoom()).toBeNull()
    checkMemory(2 ** 40)
  })

  it('refuses an object past what is left', async () => {
    let stored = 4
    const budget = new MemoryBudget(10, () => stored)
    const seen = await runWithMemory(budget, async () => {
      await Promise.resolve()
      checkMemory(6)
      expect(() => {
        checkMemory(7)
      }).toThrow(MemoryExhausted)
      stored = 12
      return memoryRoom()
    })
    expect(seen).toBe(0)
    expect(memoryRoom()).toBeNull()
  })

  it('caps nothing without a budget', async () => {
    await runWithMemory(null, () => {
      checkMemory(2 ** 40)
      return Promise.resolve()
    })
  })
})
