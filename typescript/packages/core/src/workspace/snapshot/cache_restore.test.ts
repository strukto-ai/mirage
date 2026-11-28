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
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace.ts'
import { applyStateDict, toStateDict } from './state.ts'

const ENC = new TextEncoder()

describe('a cache entry restored from a snapshot', () => {
  // The snapshot is a third entry point into the entry table, beside `set` and
  // `add`, and it has to agree with them about what "no token" is. A
  // document is not obliged to spell it the way this version does: an
  // older writer stored `''`, and an entry restored holding that would
  // answer isFresh(path, '') with true where a freshly written one
  // answers false -- a false FRESH, the one direction that serves wrong
  // bytes. Driven through applyStateDict rather than the private
  // restoreCache, because the public entry point is the one a caller reaches.
  it.each(['', null] as const)(
    'folds a %j token the way the live write entry points fold it',
    async (stored) => {
      const ws = new Workspace({ '/m/': new RAMVFS() }, { cache: {} })
      try {
        await ws.cache.set('/m/a.txt', ENC.encode('x'), { fingerprint: 'etag-1' })
        const state = await toStateDict(ws)
        const [entry] = state.cache.entries
        // Throws rather than asserts so the narrowing is real: a capture
        // that stopped emitting the entry would otherwise edit nothing and
        // the test would pass having restored an empty table.
        if (entry === undefined) throw new Error('snapshot captured no cache entry')
        entry.fingerprint = stored
        await applyStateDict(ws, state, { replaceCache: true })
        expect(await ws.cache.isFresh('/m/a.txt', '')).toBe(false)
        expect(await ws.cache.isFresh('/m/a.txt', 'etag-1')).toBe(false)
      } finally {
        await ws.close()
      }
    },
  )

  // Applied to a workspace already built, the saved entries meet that
  // workspace's own cache: one with none keeps no file content, a smaller one
  // keeps the newest that fit, and the saved drain, larger than either, is not
  // forced on them.
  it.each([
    ['none', undefined, []],
    ['smaller', { limit: 8 }, ['b']],
    ['larger', { limit: '1MB' }, ['a', 'b']],
  ] as const)('keeps what a %s target cache holds', async (_name, cache, kept) => {
    const source = new Workspace(
      { '/d/': new RAMVFS() },
      { cache: { limit: '1MB', maxDrainBytes: 1048576 } },
    )
    const target = new Workspace({ '/d/': new RAMVFS() }, cache === undefined ? {} : { cache })
    try {
      await source.cache.set('a', ENC.encode('x'.repeat(6)))
      await source.cache.set('b', ENC.encode('y'.repeat(6)))
      await applyStateDict(target, await toStateDict(source))
      const held = []
      for (const key of ['a', 'b']) if ((await target.cache.get(key)) !== null) held.push(key)
      expect(held).toEqual(kept)
      expect(target.cache.cacheSize).toBe(6 * kept.length)
      expect(target.maxDrainBytes).toBeNull()
    } finally {
      await source.close()
      await target.close()
    }
  })

  it('drops a copy it cannot replace', async () => {
    // The saved entry does not fit the target, so the target's own older copy
    // of that key goes too: the restore leaves a miss, never the bytes the
    // snapshot replaced.
    const source = new Workspace({ '/d/': new RAMVFS() }, { cache: { limit: '1MB' } })
    const target = new Workspace({ '/d/': new RAMVFS() }, { cache: { limit: 8 } })
    try {
      await source.cache.set('a', ENC.encode('x'.repeat(9)))
      await target.cache.set('a', ENC.encode('old'))
      await applyStateDict(target, await toStateDict(source))
      expect(await target.cache.get('a')).toBeNull()
      expect(target.cache.cacheSize).toBe(0)
    } finally {
      await source.close()
      await target.close()
    }
  })

  it('keeps a real token through the round trip', async () => {
    // The other half of the fold: a token that means something must
    // survive, or the fold would be indistinguishable from dropping
    // every restored token on the floor.
    const ws = new Workspace({ '/m/': new RAMVFS() }, { cache: {} })
    try {
      await ws.cache.set('/m/a.txt', ENC.encode('x'), { fingerprint: 'etag-1' })
      const state = await toStateDict(ws)
      await applyStateDict(ws, state, { replaceCache: true })
      expect(await ws.cache.isFresh('/m/a.txt', 'etag-1')).toBe(true)
    } finally {
      await ws.close()
    }
  })
})
