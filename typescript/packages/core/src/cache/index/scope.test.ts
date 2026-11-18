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
import { commandStarted, commandScope, tick } from './scope.ts'

describe('the command scope', () => {
  it('has no stamp outside any command', () => {
    expect(commandStarted()).toBeNull()
  })

  it('gives each command a later stamp', async () => {
    const first = await commandScope(() => Promise.resolve(commandStarted()))
    const second = await commandScope(() => Promise.resolve(commandStarted()))
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second ?? 0).toBeGreaterThan(first ?? 0)
    expect(commandStarted()).toBeNull()
  })

  // A $(...) inside a command runs its own commands; leaving it must not
  // leave the outer command holding the inner, later stamp.
  it('restores the outer stamp after a nested command', async () => {
    const [outer, inner] = await commandScope(async () => {
      const mine = commandStarted()
      const nested = await commandScope(() => Promise.resolve(commandStarted()))
      expect(commandStarted()).toBe(mine)
      return [mine, nested] as const
    })
    expect(outer).not.toBeNull()
    expect(inner ?? 0).toBeGreaterThan(outer ?? 0)
  })

  it('draws a write tick after the running command', async () => {
    const [started, written] = await commandScope(() =>
      Promise.resolve([commandStarted(), tick()] as const),
    )
    expect(started).not.toBeNull()
    expect(written).toBeGreaterThan(started ?? 0)
  })

  it('keeps concurrent commands on their own stamps', async () => {
    const seen: [number | null, number | null][] = []
    const one = (): Promise<void> =>
      commandScope(async () => {
        const mine = commandStarted()
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        seen.push([mine, commandStarted()])
      })
    await Promise.all([one(), one()])
    expect(seen.every(([before, after]) => before === after)).toBe(true)
    expect(seen[0]?.[0]).not.toBe(seen[1]?.[0])
  })
})
