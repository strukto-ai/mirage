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

import { describe, expect, it, vi } from 'vitest'
import type * as ClientModule from '../../core/chroma/client.ts'

vi.mock('../../core/chroma/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../../core/chroma/client.ts')
  return { ...actual, fetchPathTree: vi.fn() }
})

import * as clientMod from '../../core/chroma/client.ts'
import { DEFAULT_READ_TTL, MountMode, ReadPolicy } from '../../types.ts'
import { Mount } from '../../workspace/mount/spec.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { ChromaVFS } from './chroma.ts'

describe('chroma dispatcher under read: fresh', () => {
  // chroma lists from one tree document, so a refused listing refetches the
  // whole tree. A burst through the dispatcher belongs to no shell command;
  // fresh trusts its own refill for the window instead of refetching per call.
  it('fetches the tree once for a burst', async () => {
    const fetch = vi.mocked(clientMod.fetchPathTree)
    fetch.mockResolvedValue(
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 5 }, (_, n) => [
            `guides/g${String(n)}`,
            { size: 1, created_at: null, updated_at: null },
          ]),
        ),
      ),
    )
    const vfs = new ChromaVFS({ collectionName: 'docs' })
    const empty = { get: () => Promise.resolve({ documents: [], metadatas: [] }) }
    vi.spyOn(vfs.accessor, 'getCollection').mockResolvedValue(
      empty as unknown as Awaited<ReturnType<typeof vfs.accessor.getCollection>>,
    )
    const ws = new Workspace({
      '/knowledge': new Mount(vfs, {
        mode: MountMode.READ,
        read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL },
      }),
    })
    try {
      const names = await ws.readdir('/knowledge/guides')
      expect(names).toHaveLength(5)
      for (const name of names) await ws.stat(name)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      await ws.close()
    }
  })
})
