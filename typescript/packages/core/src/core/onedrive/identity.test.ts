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
import { liveIdentity } from './identity.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stub(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })))
}

function accessor(): OneDriveAccessor {
  return new OneDriveAccessor({ accessToken: 'tok' })
}

describe('OneDrive identity', () => {
  it('returns the cTag fingerprint with no revision', async () => {
    stub(200, {
      id: '01ITEM',
      name: 'report.docx',
      cTag: 'ctag-abc',
      file: { mimeType: 'application/vnd.openxml' },
    })
    const result = await liveIdentity(
      accessor(),
      PathSpec.fromStrPath('/Docs/report.docx', 'Docs/report.docx'),
    )
    expect(result.exists).toBe(true)
    expect(result.fingerprint).toBe('ctag-abc')
    expect(result.revision).toBeNull()
  })

  it('reports exists false on a 404', async () => {
    stub(404, { error: { code: 'itemNotFound', message: 'no' } })
    const result = await liveIdentity(
      accessor(),
      PathSpec.fromStrPath('/Docs/report.docx', 'Docs/report.docx'),
    )
    expect(result.exists).toBe(false)
    expect(result.revision).toBeNull()
    expect(result.fingerprint).toBeNull()
  })

  it('raises EISDIR for a folder', async () => {
    stub(200, { id: '01FOLDER', name: 'Docs', folder: { childCount: 2 } })
    await expect(
      liveIdentity(accessor(), PathSpec.fromStrPath('/Docs', 'Docs')),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('raises EISDIR on the mount root without a request', async () => {
    await expect(liveIdentity(accessor(), PathSpec.fromStrPath('/', ''))).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  it('raises EISDIR for a folder spelled with a trailing slash', async () => {
    // Graph is item-addressed off the slashless resourcePath, so the
    // hint costs nothing: the folder facet on the answer is what refuses
    // it, the same as without the slash.
    stub(200, { id: '01FOLDER', name: 'Docs', folder: { childCount: 2 } })
    await expect(
      liveIdentity(accessor(), PathSpec.fromStrPath('/Docs/', 'Docs')),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('reports exists false for an absent path spelled with a trailing slash', async () => {
    stub(404, { error: { code: 'itemNotFound', message: 'no' } })
    const result = await liveIdentity(accessor(), PathSpec.fromStrPath('/Docs/', 'Docs'))
    expect(result.exists).toBe(false)
    expect(result.revision).toBeNull()
    expect(result.fingerprint).toBeNull()
  })
})
