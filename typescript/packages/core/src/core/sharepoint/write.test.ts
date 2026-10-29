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
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { write } from './write.ts'

// A key named like its mount: neither `m/k.txt` nor `/m/k.txt` is virtual.
const SPEC = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SharePoint write', () => {
  it('write PUTs the bytes and records a write', async () => {
    const fetchMock = vi.fn((input: unknown) => {
      const url = String(input)
      const body = url.includes('/sites?')
        ? { value: [{ id: 'site-id', displayName: 'Team' }] }
        : url.includes('/drives?')
          ? { value: [{ id: 'drive-id', name: 'Documents' }] }
          : { id: 'item' }
      return Promise.resolve(new Response(JSON.stringify(body)))
    })
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new SharePointAccessor({
      accessToken: 'token',
      site: 'Team',
      drive: 'Documents',
    })
    const [, records] = await runWithRecording(() =>
      write(accessor, SPEC, new TextEncoder().encode('hi')),
    )
    const [url, init] = fetchMock.mock.calls[2] as unknown as [string, RequestInit]
    expect(init.method).toBe('PUT')
    expect(url).toBe('https://graph.microsoft.com/v1.0/drives/drive-id/root:/m/k.txt:/content')
    expect(records).toMatchObject([
      { op: 'write', path: '/m/m/k.txt', source: 'sharepoint', bytes: 2 },
    ])
  })
})

vi.mock('../msgraph/paths.ts', () => ({ checkItem: vi.fn().mockResolvedValue(null) }))
