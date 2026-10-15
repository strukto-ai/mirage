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
import { PathSpec } from '../../types.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

function answer(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OneDrive stat', () => {
  // A folder's `size` is Graph's aggregate subtree storage number, not
  // rendered content length, the mount root's included.
  it.each([
    ['/od/Docs', 'Docs'],
    ['/od', ''],
  ])('keeps the aggregate size of %s out of FileStat.size', async (virtual, key) => {
    answer({ id: 'folder', name: 'Docs', size: 4096, folder: { childCount: 2 } })
    const info = await stat(
      new OneDriveAccessor({ accessToken: 'token' }),
      PathSpec.fromStrPath(virtual, key),
    )
    expect(info.size).toBeNull()
    expect(info.extra).toMatchObject({ size_bytes: 4096, child_count: 2 })
  })

  it('lists a folder without a fingerprint', async () => {
    answer({
      value: [{ id: 'dir', name: 'Docs', cTag: 'ctag-dir', folder: { childCount: 1 } }],
    })
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const [docs] = await readdir(accessor, PathSpec.fromStrPath('/od', ''))
    expect(docs?.type).toBe('directory')
    expect(docs?.fingerprint).toBeNull()
  })
})
