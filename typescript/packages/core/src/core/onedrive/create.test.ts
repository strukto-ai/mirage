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
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { create } from './create.ts'

// A key named like its mount: neither `m/k.txt` nor `/m/k.txt` is virtual.
const SPEC = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OneDrive create', () => {
  it('create PUTs empty content and records a create, not a write', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'item' })))
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const [, records] = await runWithRecording(() => create(accessor, SPEC))
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe('PUT')
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://graph.microsoft.com/v1.0/me/drive/root:/m/k.txt:/content',
    )
    expect(records).toMatchObject([
      { op: 'create', path: '/m/m/k.txt', source: 'onedrive', bytes: 0 },
    ])
  })
})

vi.mock('../msgraph/paths.ts', () => ({ checkItem: vi.fn().mockResolvedValue(null) }))
