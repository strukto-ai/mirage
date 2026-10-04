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

  it('a prefix invalidation reaches the writers under it', () => {
    const inv = new Invalidation()
    const under = inv.enter('/a/x')
    const deeper = inv.enter('/a/b/c')
    const spared = ['/b', '/a', '/ab/x'].map((key) => [key, inv.enter(key)] as const)
    inv.invalidatePrefix('/a/')
    expect(inv.stale('/a/x', under)).toBe(true)
    expect(inv.stale('/a/b/c', deeper)).toBe(true)
    for (const [key, stamp] of spared) expect(inv.stale(key, stamp)).toBe(false)
    for (const key of ['/a/x', '/a/b/c', '/b', '/a', '/ab/x']) inv.leave(key)
    // The counters went with the last writer out: a new stamp is fresh.
    const again = inv.enter('/a/x')
    expect(inv.stale('/a/x', again)).toBe(false)
    expect(again).toEqual(inv.enter('/zz'))
    inv.leave('/a/x')
    inv.leave('/zz')
  })

  it('a prefix invalidation spares an excluded root', () => {
    const inv = new Invalidation()
    const nested = inv.enter('/a/nested/f')
    const root = inv.enter('/a/nested')
    const sibling = inv.enter('/a/nested2')
    inv.invalidatePrefix('/a/', ['/a/nested'])
    expect(inv.stale('/a/nested/f', nested)).toBe(false)
    expect(inv.stale('/a/nested', root)).toBe(false)
    expect(inv.stale('/a/nested2', sibling)).toBe(true)
    for (const key of ['/a/nested/f', '/a/nested', '/a/nested2']) inv.leave(key)
  })

  it('a prefix invalidation with no writer leaves nothing behind', () => {
    const inv = new Invalidation()
    const before = inv.enter('/zz')
    inv.leave('/zz')
    inv.invalidatePrefix('/a/')
    for (const key of ['/a/', '/a/x']) {
      expect(inv.enter(key)).toEqual(before)
      inv.leave(key)
    }
  })
})
