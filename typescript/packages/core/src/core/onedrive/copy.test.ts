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
import { runWithCacheManager, type CacheInvalidator } from '../../cache/context.ts'
import { PathSpec } from '../../types.ts'
import { copy } from './copy.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function recorder(): [CacheInvalidator, string[]] {
  const seen: string[] = []
  const note = (kind: string) => (path: string | PathSpec) => {
    seen.push(`${kind} ${typeof path === 'string' ? path : path.virtual}`)
    return Promise.resolve()
  }
  const manager: CacheInvalidator = {
    invalidateAfterWrite: note('write'),
    invalidateAfterUnlink: note('unlink'),
    invalidateSubtree: note('subtree'),
    invalidateAncestors: note('ancestors'),
    cachedBytes: () => Promise.resolve(null),
    readThrough: (_path, fetch) => fetch(),
    cachedSize: () => Promise.resolve(null),
    listingTrusted: () => false,
    probedStat: () => null,
  }
  return [manager, seen]
}

describe('OneDrive copy', () => {
  // A key named like its mount: the mount-relative `/m/k.txt` names another
  // file under a `/m` mount. A failed copy invalidates too: a merge may have
  // landed some children first.
  it.each(['completed', 'failed'])(
    'invalidates the destination subtree under its mount-absolute path (%s)',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn((_input: unknown, init?: RequestInit) =>
          Promise.resolve(
            init?.method === 'POST'
              ? new Response(null, { status: 202, headers: { Location: 'https://monitor.test/1' } })
              : new Response(JSON.stringify({ status, error: {} }), { status: 200 }),
          ),
        ),
      )
      const src = new PathSpec({ virtual: '/m/a.txt', vfsPath: 'a.txt', directory: '/m/' })
      const dst = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })
      const [manager, seen] = recorder()
      const outcome = runWithCacheManager(manager, () =>
        copy(new OneDriveAccessor({ accessToken: 'token' }), src, dst),
      )
      if (status === 'failed') await expect(outcome).rejects.toThrow()
      else await outcome
      expect(seen).toEqual(['subtree /m/m/k.txt'])
    },
  )
})
