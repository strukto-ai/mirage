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
import type * as ClientModule from '../google/client.ts'

vi.mock('../google/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../google/client.ts')
  return { ...actual, googleGet: vi.fn(), googleGetBytes: vi.fn() }
})

import type { TokenManager } from '../google/client.ts'
import { googleGet, googleGetBytes } from '../google/client.ts'
import { captureFileMetadata, downloadRevision, listRevisions } from './versions.ts'

const TM = { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager

describe('gdrive versions', () => {
  it('listRevisions paginates', async () => {
    vi.mocked(googleGet)
      .mockResolvedValueOnce({ revisions: [{ id: 'r1' }], nextPageToken: 'next' })
      .mockResolvedValueOnce({ revisions: [{ id: 'r2' }] })
    const revs = await listRevisions(TM, 'f1')
    expect(revs.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('downloadRevision hits the revision URL', async () => {
    const enc = new TextEncoder()
    vi.mocked(googleGetBytes).mockResolvedValue(enc.encode('old'))
    const data = await downloadRevision(TM, 'f1', 'r1')
    expect(new TextDecoder().decode(data)).toBe('old')
    const call = vi.mocked(googleGetBytes).mock.calls.at(-1)
    expect(call?.[1]).toContain('/files/f1/revisions/r1?alt=media')
  })

  it('captureFileMetadata returns the three slots raw', async () => {
    // The coalescing that used to happen here now happens in the caller,
    // through driveFingerprint: the caller verifies an md5 against the bytes
    // it downloaded, and a token it could not tell apart from a revision
    // would be dropped for every file Drive gives no md5 for.
    vi.mocked(googleGet).mockResolvedValueOnce({ headRevisionId: 'r9', md5Checksum: 'abc' })
    expect(await captureFileMetadata(TM, 'f1')).toEqual(['abc', 'r9', null])
    vi.mocked(googleGet).mockResolvedValueOnce({ headRevisionId: 'r9' })
    expect(await captureFileMetadata(TM, 'f1')).toEqual([null, 'r9', null])
  })

  it('captureFileMetadata asks for the stamp and returns it', async () => {
    // The third slot is what keeps a token-less file matching: a Drive
    // shortcut has no md5 and no revision, and without the stamp the read
    // would answer null while stat answered one.
    vi.mocked(googleGet).mockResolvedValueOnce({ modifiedTime: '2026-04-01T00:00:00.000Z' })
    expect(await captureFileMetadata(TM, 'f1')).toEqual([null, null, '2026-04-01T00:00:00.000Z'])
    const params = vi.mocked(googleGet).mock.calls.at(-1)?.[2] as Record<string, unknown>
    expect(String(params.fields)).toContain('modifiedTime')
  })
})
