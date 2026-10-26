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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { YIELD_CALLS, YIELD_INTERVAL, YieldBudget } from './yield_budget.ts'

describe('YieldBudget', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts at its first run', () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const budget = new YieldBudget()
    now += YIELD_INTERVAL * 3
    expect(budget.run()).toBeUndefined()
    now += YIELD_INTERVAL
    expect(budget.run()).toBeInstanceOf(Promise)
  })

  it('yields within the call bound on a clock that stands still', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const budget = new YieldBudget()
    let calls = 0
    let pending: Promise<void> | undefined
    while (pending === undefined) {
      calls += 1
      pending = budget.run()
    }
    await pending
    expect(calls).toBe(YIELD_CALLS)
    expect(budget.run()).toBeUndefined()
  })
})
