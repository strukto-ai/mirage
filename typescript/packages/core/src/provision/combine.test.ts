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
import { scaled } from './combine.ts'
import { ProvisionResult } from './types.ts'

describe('scaled cost', () => {
  it('multiplies estimatedCostUsd and keeps null costs null', () => {
    const priced = new ProvisionResult({
      networkReadLow: 10,
      networkReadHigh: 10,
      readOps: 1,
      estimatedCostUsd: 0.5,
    })
    const tripled = scaled(priced, 3)
    expect(tripled.networkReadLow).toBe(30)
    expect(tripled.estimatedCostUsd).toBe(1.5)
    const free = new ProvisionResult({ networkReadLow: 10, networkReadHigh: 10 })
    expect(scaled(free, 3).estimatedCostUsd).toBeNull()
  })
})
