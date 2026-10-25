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
import { TokenManager } from './oauth.ts'
import { ManualClock, SystemClock } from '../../utils/clock.ts'

class FakeManager extends TokenManager {
  calls = 0
  constructor(
    private readonly expiresIn: number,
    bufferSeconds: number,
  ) {
    super(bufferSeconds)
  }

  protected refreshPair(): Promise<[string, number]> {
    this.calls += 1
    return Promise.resolve([`tok${String(this.calls)}`, this.expiresIn])
  }
}

describe('TokenManager', () => {
  it('caches until expiry', async () => {
    const tm = new FakeManager(3600, 300)
    expect(await tm.getToken()).toBe('tok1')
    expect(await tm.getToken()).toBe('tok1')
    expect(tm.calls).toBe(1)
  })

  it('the buffer refreshes early', async () => {
    // 200s of lifetime minus a 300s buffer is already expired, so every
    // call refreshes.
    const tm = new FakeManager(200, 300)
    expect(await tm.getToken()).toBe('tok1')
    expect(await tm.getToken()).toBe('tok2')
    expect(tm.calls).toBe(2)
  })

  it('concurrent callers share one refresh', async () => {
    const tm = new FakeManager(3600, 300)
    const tokens = await Promise.all([tm.getToken(), tm.getToken(), tm.getToken()])
    expect(tokens).toEqual(['tok1', 'tok1', 'tok1'])
    expect(tm.calls).toBe(1)
  })
})

describe('TokenManager clock binding', () => {
  it('refuses another clock while held', () => {
    const tm = new FakeManager(3600, 300)
    const first = new ManualClock()
    tm.bindClock(first, 'a')
    expect(() => {
      tm.bindClock(new ManualClock(), 'b')
    }).toThrow(/another clock/)
    expect(tm.clock).toBe(first)
  })

  it('takes another clock once every owner lets go', () => {
    const tm = new FakeManager(3600, 300)
    const first = new ManualClock()
    const second = new ManualClock()
    tm.bindClock(first, 'a')
    tm.bindClock(first, 'b')
    tm.releaseClock('a')
    expect(() => {
      tm.bindClock(second, 'c')
    }).toThrow()
    tm.releaseClock('b')
    tm.bindClock(second, 'c')
    expect(tm.clock).toBe(second)
  })

  it("keeps another owner's hold when one lets go twice", () => {
    const tm = new FakeManager(3600, 300)
    tm.bindClock(new ManualClock(), 'a')
    tm.bindClock(tm.clock, 'b')
    tm.releaseClock('a')
    tm.releaseClock('a')
    expect(() => {
      tm.bindClock(new ManualClock(), 'c')
    }).toThrow()
  })

  it('changes nothing when an owner holds again', () => {
    const tm = new FakeManager(3600, 300)
    const clock = new ManualClock()
    tm.bindClock(clock, 'a')
    tm.bindClock(clock, 'a')
    tm.releaseClock('a')
    tm.bindClock(new ManualClock(), 'b')
  })

  it('lets two system clocks agree while held', () => {
    const tm = new FakeManager(3600, 300)
    tm.bindClock(new SystemClock(), 'a')
    tm.bindClock(new SystemClock(), 'b')
    expect(() => {
      tm.bindClock(new ManualClock(), 'c')
    }).toThrow()
  })
})
