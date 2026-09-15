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
import { Precision, ProvisionResult } from './types.ts'

describe('ProvisionResult', () => {
  it('defaults: counters are 0, precision is EXACT, cost is null', () => {
    const r = new ProvisionResult()
    expect(r.networkReadLow).toBe(0)
    expect(r.precision).toBe(Precision.EXACT)
    expect(r.estimatedCostUsd).toBe(null)
  })

  it('networkRead getter returns "low-high" when bounds differ', () => {
    const r = new ProvisionResult({ networkReadLow: 100, networkReadHigh: 200 })
    expect(r.networkRead).toBe('100-200')
  })

  it('networkRead getter returns a single value when bounds are equal', () => {
    const r = new ProvisionResult({ networkReadLow: 100, networkReadHigh: 100 })
    expect(r.networkRead).toBe('100')
  })
})

describe('Precision enum', () => {
  it('EXACT/RANGE/UNKNOWN have string values', () => {
    expect(Precision.EXACT).toBe('exact')
    expect(Precision.RANGE).toBe('range')
    expect(Precision.UNKNOWN).toBe('unknown')
  })
})
