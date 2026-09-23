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
  // The snapshot is a third door into the entry table, beside `set` and
  // `add`, and it has to agree with them about what "no token" is. A
  // document is not obliged to spell it the way this version does: an
  // older writer stored `''`, and an entry restored holding that would
  // answer isFresh(path, '') with true where a freshly written one
  // answers false -- a false FRESH, the one direction that serves wrong
  // bytes. Driven through applyStateDict rather than the private
  // restoreCache, because the public door is the one a caller reaches.
  it.each(['', null] as const)(
    'folds a %j token the way the live write doors fold it',
    async (stored) => {
      const ws = new Workspace({ '/m/': new RAMVFS() })
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

  it('keeps a real token through the round trip', async () => {
    // The other half of the fold: a token that means something must
    // survive, or the fold would be indistinguishable from dropping
    // every restored token on the floor.
    const ws = new Workspace({ '/m/': new RAMVFS() })
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
