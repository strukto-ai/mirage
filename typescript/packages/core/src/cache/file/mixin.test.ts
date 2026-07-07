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
import { drainBudget } from './mixin.ts'
import { RAMFileCacheStore } from './ram.ts'

describe('drainBudget', () => {
  it('defaults to cacheLimit when maxDrainBytes is null', () => {
    const cache = new RAMFileCacheStore({ limit: 1024 })
    expect(cache.maxDrainBytes).toBeNull()
    expect(drainBudget(cache)).toBe(1024)
  })

  it('keeps maxDrainBytes below the limit', () => {
    const cache = new RAMFileCacheStore({ limit: 1024, maxDrainBytes: 100 })
    expect(drainBudget(cache)).toBe(100)
  })

  it('clamps maxDrainBytes above the limit', () => {
    const cache = new RAMFileCacheStore({ limit: 1024, maxDrainBytes: 4096 })
    expect(drainBudget(cache)).toBe(1024)
  })
})
