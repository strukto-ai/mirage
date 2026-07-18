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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it, vi } from 'vitest'
import type * as DriveModule from '../google/drive.ts'
import type * as ClientModule from '../google/_client.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  return { ...actual, listAllFiles: vi.fn() }
})

vi.mock('../google/_client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../google/_client.ts')
  return { ...actual, googleGet: vi.fn() }
})

import { GSlidesAccessor } from '../../accessor/gslides.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/_client.ts'
import * as drive from '../google/drive.ts'
import * as client from '../google/_client.ts'
import { read } from './read.ts'

const STUB_TOKEN_MANAGER = {
  config: { clientId: 'cid', refreshToken: 'rt' },
} as TokenManager

function makeAccessor(): GSlidesAccessor {
  return new GSlidesAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

describe('gslides read auto-bootstrap', () => {
  it('refetches owned listing when entry is evicted from index', async () => {
    vi.mocked(drive.listAllFiles).mockResolvedValue([
      {
        id: 'slide1',
        name: 'Deck',
        modifiedTime: '2026-04-01T00:00:00.000Z',
        owners: [{ me: true }],
      },
    ])
    vi.mocked(client.googleGet).mockResolvedValue({ presentationId: 'slide1' })

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      virtual: '/gslides/owned/2026-04-01_Deck__slide1.gslide.json',
      directory: '/gslides/owned/2026-04-01_Deck__slide1.gslide.json',
      resourcePath: mountKey('/gslides/owned/2026-04-01_Deck__slide1.gslide.json', '/gslides'),
    })
    const out = await read(accessor, path, index)
    expect(new TextDecoder().decode(out)).toContain('slide1')
  })

  it('throws ENOENT when file missing even after recursion', async () => {
    vi.mocked(drive.listAllFiles).mockResolvedValue([])
    vi.mocked(client.googleGet).mockRejectedValue(new Error('should not call googleGet'))

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const path = new PathSpec({
      virtual: '/gslides/owned/Missing__xyz.gslide.json',
      directory: '/gslides/owned/Missing__xyz.gslide.json',
      resourcePath: mountKey('/gslides/owned/Missing__xyz.gslide.json', '/gslides'),
    })
    await expect(read(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
