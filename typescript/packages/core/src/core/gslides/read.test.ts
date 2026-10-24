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
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GSlidesAccessor } from '../../accessor/gslides.ts'
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec, type FileStat } from '../../types.ts'
import { GSlidesVFS } from '../../vfs/gslides/gslides.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { TokenManager } from '../google/client.ts'
import type { SlidesApi } from './api.ts'
import { read } from './read.ts'
import { stubDrive, type StubDrive } from '../../../tests/core/gdrive/_test_util.ts'
import { installApi } from '../../../tests/core/google/_test_util.ts'

const ENC = new TextEncoder()

let drive: StubDrive
let slides: { readPresentation: ReturnType<typeof vi.fn<SlidesApi['readPresentation']>> }

beforeEach(() => {
  drive = stubDrive()
  slides = { readPresentation: vi.fn<SlidesApi['readPresentation']>() }
  installApi({ drive, slides })
})

const STUB_TOKEN_MANAGER = new TokenManager({ clientId: 'cid', refreshToken: 'rt' })

function makeAccessor(): GSlidesAccessor {
  return new GSlidesAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

describe('gslides read auto-bootstrap', () => {
  it('resolves a read no listing named by its id', async () => {
    drive.getFile.mockResolvedValue({
      mimeType: 'application/vnd.google-apps.presentation',
      id: 'slide1',
      name: 'Deck',
      modifiedTime: '2026-04-01T00:00:00.000Z',
      owners: [{ me: true }],
    })
    slides.readPresentation.mockResolvedValue(
      ENC.encode(JSON.stringify({ presentationId: 'slide1' })),
    )

    const accessor = makeAccessor()
    const path = new PathSpec({
      virtual: '/gslides/owned/2026-04-01_Deck__slide1.gslide.json',
      directory: '/gslides/owned/2026-04-01_Deck__slide1.gslide.json',
      vfsPath: mountKey('/gslides/owned/2026-04-01_Deck__slide1.gslide.json', '/gslides'),
    })
    const out = await read(accessor, path)
    expect(new TextDecoder().decode(out)).toContain('slide1')
  })

  it('throws ENOENT when file missing by ID', async () => {
    drive.getFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    slides.readPresentation.mockRejectedValue(new Error('should not call readPresentation'))

    const accessor = makeAccessor()
    const path = new PathSpec({
      virtual: '/gslides/owned/Missing__xyz.gslide.json',
      directory: '/gslides/owned/Missing__xyz.gslide.json',
      vfsPath: mountKey('/gslides/owned/Missing__xyz.gslide.json', '/gslides'),
    })
    await expect(read(accessor, path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('gslides read token', () => {
  // read: fresh compares this record with stat's fingerprint, so both take
  // the file's modified stamp, and a file without one stamps nothing.
  const cases: [string, string | null][] = [
    ['2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'],
    ['', null],
  ]
  for (const [stamp, token] of cases) {
    it(`records the token stat reports (stamp ${JSON.stringify(stamp)})`, async () => {
      const item = {
        mimeType: 'application/vnd.google-apps.presentation',
        id: 'd1',
        name: 'My Deck',
        modifiedTime: stamp,
        owners: [{ me: true }],
      }
      drive.listAllFiles.mockResolvedValue({ files: [item], complete: true })
      drive.getFile.mockResolvedValue(item)
      slides.readPresentation.mockResolvedValue(
        ENC.encode(JSON.stringify({ presentationId: 'd1' })),
      )
      const accessor = makeAccessor()
      const vfs = Object.assign(
        new GSlidesVFS({ clientId: 'id', clientSecret: 's', refreshToken: 'rt' }),
        { accessor },
      )
      const ws = new Workspace({ '/gslides/': vfs })
      const [target = ''] = (await ws.dispatch('readdir', '/gslides/owned')) as string[]
      const path = new PathSpec({
        virtual: target,
        directory: target,
        vfsPath: mountKey(target, '/gslides'),
      })
      const [data, records] = await runWithRecording(() => read(accessor, path))
      const info = (await ws.dispatch('stat', target)) as FileStat
      expect(records.map((r) => [r.op, r.path, r.source, r.bytes, r.fingerprint])).toEqual([
        ['read', target, 'gslides', data.byteLength, token],
      ])
      expect(info.fingerprint).toBe(token)
    })
  }
})
