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
import type * as ClientModule from '../google/client.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  return { ...actual, listAllFiles: vi.fn(), getFile: vi.fn() }
})

vi.mock('../google/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../google/client.ts')
  return { ...actual, googleGet: vi.fn() }
})

import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec, type FileStat } from '../../types.ts'
import { GDocsVFS } from '../../vfs/gdocs/gdocs.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { TokenManager } from '../google/client.ts'
import * as drive from '../google/drive.ts'
import * as client from '../google/client.ts'
import { read, readDoc } from './read.ts'

const STUB_TOKEN_MANAGER = {
  config: { clientId: 'cid', refreshToken: 'rt' },
} as TokenManager

function makeAccessor(): GDocsAccessor {
  return new GDocsAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

describe('gdocs read auto-bootstrap', () => {
  it('resolves a read no listing named by its id', async () => {
    vi.mocked(drive.getFile).mockResolvedValue({
      mimeType: 'application/vnd.google-apps.document',
      id: 'doc1',
      name: 'Notes',
      modifiedTime: '2026-04-01T00:00:00.000Z',
      owners: [{ me: true }],
    })
    vi.mocked(client.googleGet).mockResolvedValue({ documentId: 'doc1' })

    const accessor = makeAccessor()
    const path = new PathSpec({
      virtual: '/gdocs/owned/2026-04-01_Notes__doc1.gdoc.json',
      directory: '/gdocs/owned/2026-04-01_Notes__doc1.gdoc.json',
      vfsPath: mountKey('/gdocs/owned/2026-04-01_Notes__doc1.gdoc.json', '/gdocs'),
    })
    const out = await read(accessor, path)
    expect(new TextDecoder().decode(out)).toContain('doc1')
  })

  it('throws ENOENT when file missing by ID', async () => {
    vi.mocked(drive.getFile).mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    )
    vi.mocked(client.googleGet).mockRejectedValue(new Error('should not call googleGet'))

    const accessor = makeAccessor()
    const path = new PathSpec({
      virtual: '/gdocs/owned/Missing__xyz.gdoc.json',
      directory: '/gdocs/owned/Missing__xyz.gdoc.json',
      vfsPath: mountKey('/gdocs/owned/Missing__xyz.gdoc.json', '/gdocs'),
    })
    await expect(read(accessor, path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // The Drive-item read family (gdocs/gsheets/gslides) shares this shape:
  // only an absent parent may collapse into the operand's ENOENT.
  it('propagates a failed metadata request instead of reporting ENOENT', async () => {
    vi.mocked(drive.getFile).mockRejectedValue(new Error('google unavailable'))
    vi.mocked(client.googleGet).mockRejectedValue(new Error('should not call googleGet'))

    const accessor = makeAccessor()
    const path = new PathSpec({
      virtual: '/gdocs/owned/Missing__xyz.gdoc.json',
      directory: '/gdocs/owned/Missing__xyz.gdoc.json',
      vfsPath: mountKey('/gdocs/owned/Missing__xyz.gdoc.json', '/gdocs'),
    })
    await expect(read(accessor, path)).rejects.toThrow(/google unavailable/)
  })
})

describe('gdocs readDoc', () => {
  it('requests tab-aware content so multi-tab documents are not truncated', async () => {
    vi.mocked(client.googleGet).mockResolvedValue({
      documentId: 'abc123',
      title: 'Test Doc',
      tabs: [],
    })

    const out = await readDoc(STUB_TOKEN_MANAGER, 'abc123')
    expect(new TextDecoder().decode(out)).toContain('abc123')
    // The flag rides `params`, the way gsheets sends includeGridData, so
    // the two halves of one family ask for their content the same way and
    // python's read_doc has a call to mirror.
    expect(client.googleGet).toHaveBeenCalledWith(
      STUB_TOKEN_MANAGER,
      'https://docs.googleapis.com/v1/documents/abc123',
      { includeTabsContent: 'true' },
    )
  })
})

describe('gdocs read token', () => {
  // read: fresh compares this record with stat's fingerprint, so both take
  // the file's modified stamp, and a file without one stamps nothing.
  const cases: [string, string | null][] = [
    ['2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'],
    ['', null],
  ]
  for (const [stamp, token] of cases) {
    it(`records the token stat reports (stamp ${JSON.stringify(stamp)})`, async () => {
      const item = {
        mimeType: 'application/vnd.google-apps.document',
        id: 'doc1',
        name: 'My Doc',
        modifiedTime: stamp,
        owners: [{ me: true }],
      }
      vi.mocked(drive.listAllFiles).mockResolvedValue({ files: [item], complete: true })
      vi.mocked(drive.getFile).mockResolvedValue(item)
      vi.mocked(client.googleGet).mockResolvedValue({ documentId: 'doc1' })
      const accessor = makeAccessor()
      const vfs = Object.assign(
        new GDocsVFS({ clientId: 'id', clientSecret: 's', refreshToken: 'rt' }),
        { accessor },
      )
      const ws = new Workspace({ '/gdocs/': vfs })
      const [target = ''] = (await ws.dispatch('readdir', '/gdocs/owned')) as string[]
      const path = new PathSpec({
        virtual: target,
        directory: target,
        vfsPath: mountKey(target, '/gdocs'),
      })
      const [data, records] = await runWithRecording(() => read(accessor, path))
      const info = (await ws.dispatch('stat', target)) as FileStat
      expect(records.map((r) => [r.op, r.path, r.source, r.bytes, r.fingerprint])).toEqual([
        ['read', target, 'gdocs', data.byteLength, token],
      ])
      expect(info.fingerprint).toBe(token)
    })
  }
})
