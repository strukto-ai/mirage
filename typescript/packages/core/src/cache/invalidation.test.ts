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
import { Invalidation } from './invalidation.ts'

describe('Invalidation', () => {
  it('a removal of the key makes the stamp stale', () => {
    const inv = new Invalidation()
    const stamp = inv.enter('/a')
    inv.invalidate('/a')
    expect(inv.stale('/a', stamp)).toBe(true)
    inv.leave('/a')
  })

  it('a removal of another key does not', () => {
    const inv = new Invalidation()
    const stamp = inv.enter('/a')
    inv.invalidate('/b')
    expect(inv.stale('/a', stamp)).toBe(false)
    inv.leave('/a')
  })

  it('a store-wide invalidation reaches every writer', () => {
    const inv = new Invalidation()
    const stamp = inv.enter('/a')
    inv.invalidateAll()
    expect(inv.stale('/a', stamp)).toBe(true)
    inv.leave('/a')
  })

  it('a removal with no writer in flight leaves nothing behind', () => {
    const inv = new Invalidation()
    inv.invalidate('/a')
    const stamp = inv.enter('/a')
    expect(inv.stale('/a', stamp)).toBe(false)
    inv.leave('/a')
  })

  it('the last writer out drops the key counter', () => {
    const inv = new Invalidation()
    const first = inv.enter('/a')
    const second = inv.enter('/a')
    inv.invalidate('/a')
    inv.leave('/a')
    expect(inv.stale('/a', second)).toBe(true)
    inv.leave('/a')
    // The counter reset, so a new writer's stamp is the first one again.
    // `stale(...) === false` would pass with the counter left in place.
    expect(inv.enter('/a')).toEqual(first)
    inv.leave('/a')
  })
})
