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
import { SharePointAccessor } from '../../accessor/sharepoint.ts'
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

function requestUrl(input: URL | RequestInfo): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sharepoint live_identity op', () => {
  it('ignores a poisoned index', async () => {
    const fetchMock = vi.fn((input: URL | RequestInfo) => {
      const url = requestUrl(input)
      if (url.includes('/sites?')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              value: [{ id: 'site-id', displayName: 'Engineering', name: 'eng' }],
            }),
            { status: 200 },
          ),
        )
      }
      if (url.includes('/drives?') || url.endsWith('/drives')) {
        return Promise.resolve(
          new Response(JSON.stringify({ value: [{ id: 'drive-id', name: 'Documents' }] }), {
            status: 200,
          }),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: '01ITEM', name: 'report.docx', cTag: 'ctag-abc', file: {} }),
          { status: 200 },
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new SharePointAccessor({ accessToken: 'tok' })
    const path = PathSpec.fromStrPath(
      '/sp/Engineering/Documents/report.docx',
      'Engineering/Documents/report.docx',
    )
    const result = (await liveIdentityOp.fn(accessor, path, [], {
      index: new PoisonIndex(),
    })) as { exists: boolean; fingerprint: string | null }
    expect(result.exists).toBe(true)
    expect(result.fingerprint).toBe('ctag-abc')
  })
})
