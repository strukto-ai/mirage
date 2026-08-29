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
import { PathSpec } from '../../types.ts'
import { GraphError } from './client.ts'
import { resolveMsGraphConfig } from './config.ts'
import { DriveLoc, identityItem } from './drive.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function loc(path: string): DriveLoc {
  return new DriveLoc({
    drive: 'd1',
    path,
    virtual: path,
    url: (p, action = '') => `https://graph.example/drives/d1/root:/${p}:${action}`,
    ref: (folder = '') => `/drives/d1/root:/${folder ?? ''}`,
  })
}

function stub(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })))
}

describe('identityItem', () => {
  it('returns the cTag fingerprint with no revision', async () => {
    stub(200, { id: '1', name: 'a.txt', cTag: 'ctag-1', file: {} })
    const result = await identityItem(
      resolveMsGraphConfig({ accessToken: 'token' }),
      loc('a.txt'),
      PathSpec.fromStrPath('/a.txt', 'a.txt'),
    )
    expect(result.exists).toBe(true)
    expect(result.fingerprint).toBe('ctag-1')
    // Bounded per the identity contract: identityItem never issues the
    // $expand=versions call captureItemMetadata makes, so revision stays
    // null until a bounded revision call is proven safe.
    expect(result.revision).toBeNull()
  })

  it('reports exists false on a 404', async () => {
    stub(404, { error: { code: 'itemNotFound', message: 'no' } })
    const result = await identityItem(
      resolveMsGraphConfig({ accessToken: 'token' }),
      loc('missing.txt'),
      PathSpec.fromStrPath('/missing.txt', 'missing.txt'),
    )
    expect(result.exists).toBe(false)
    expect(result.revision).toBeNull()
    expect(result.fingerprint).toBeNull()
  })

  it('raises EISDIR for a folder', async () => {
    stub(200, { id: '2', name: 'dir', folder: { childCount: 0 } })
    await expect(
      identityItem(
        resolveMsGraphConfig({ accessToken: 'token' }),
        loc('dir'),
        PathSpec.fromStrPath('/dir', 'dir'),
      ),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('propagates a non-404 GraphError', async () => {
    // 403 is not in RETRY_STATUSES, so this fails on the first attempt
    // instead of exhausting the client's retry/backoff loop.
    stub(403, { error: { code: 'accessDenied', message: 'no' } })
    await expect(
      identityItem(
        resolveMsGraphConfig({ accessToken: 'token' }),
        loc('a.txt'),
        PathSpec.fromStrPath('/a.txt', 'a.txt'),
      ),
    ).rejects.toBeInstanceOf(GraphError)
  })
})
