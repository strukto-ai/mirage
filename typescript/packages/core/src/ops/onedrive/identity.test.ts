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
import { OneDriveAccessor } from '../../accessor/onedrive.ts'
import type { IndexEntry, ListResult, LookupResult } from '../../cache/index/config.ts'
import { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { liveIdentityOp } from './identity.ts'

/** An index cache that fails loudly if the op ever consults it. */
class PoisonIndex extends IndexCacheStore {
  get(_resourcePath: string): Promise<LookupResult> {
    throw new Error('live_identity must not touch index.get')
  }
  put(_resourcePath: string, _entry: IndexEntry): Promise<void> {
    throw new Error('live_identity must not touch index.put')
  }
  listDir(_resourcePath: string): Promise<ListResult> {
    throw new Error('live_identity must not touch index.listDir')
  }
  setDir(): Promise<void> {
    throw new Error('live_identity must not touch index.setDir')
  }
  invalidateDir(_resourcePath: string): Promise<void> {
    throw new Error('live_identity must not touch index.invalidateDir')
  }
  invalidatePrefix(_resourcePath: string): Promise<void> {
    throw new Error('live_identity must not touch index.invalidatePrefix')
  }
  invalidate(): Promise<void> {
    throw new Error('live_identity must not touch index.invalidate')
  }
  clear(): Promise<void> {
    throw new Error('live_identity must not touch index.clear')
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('onedrive live_identity op', () => {
  it('ignores a poisoned index', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ id: '01ITEM', name: 'report.docx', cTag: 'ctag-abc', file: {} }),
            { status: 200 },
          ),
        ),
    )
    const accessor = new OneDriveAccessor({ accessToken: 'tok' })
    const path = PathSpec.fromStrPath('/Docs/report.docx', 'Docs/report.docx')
    const result = (await liveIdentityOp.fn(accessor, path, [], {
      index: new PoisonIndex(),
    })) as { exists: boolean; fingerprint: string | null }
    expect(result.exists).toBe(true)
    expect(result.fingerprint).toBe('ctag-abc')
  })
})
