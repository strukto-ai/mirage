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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { ioFor } from '../../test-utils.ts'
import { OneDriveVFS } from './onedrive.ts'

const BASE = 'https://graph.microsoft.com/v1.0/me/drive'

// `a.txt` and `sub/b.txt`; every request is logged.
function tree(): string[] {
  const routes: Record<string, unknown> = {
    [`${BASE}/root`]: { id: 'root', name: 'root', folder: { childCount: 2 } },
    [`${BASE}/root/children`]: {
      value: [
        { id: '1', name: 'a.txt', size: 3, file: {} },
        { id: '2', name: 'sub', size: 99, folder: { childCount: 1 } },
      ],
    },
    [`${BASE}/root:/sub:/children`]: { value: [{ id: '3', name: 'b.txt', size: 5, file: {} }] },
  }
  const seen: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input).split('?')[0] ?? ''
      seen.push(url)
      const body = routes[url]
      return Promise.resolve(
        body === undefined
          ? new Response(JSON.stringify({ error: { code: 'itemNotFound' } }), { status: 404 })
          : new Response(JSON.stringify(body)),
      )
    }),
  )
  return seen
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OneDrive du', () => {
  it('walks one list per folder, with file sizes only', async () => {
    const seen = tree()
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const root = PathSpec.fromStrPath('/od', '')
    const [entries, total] = (await ioFor(OneDriveVFS, accessor).du?.entries(
      accessor,
      root,
      new RAMIndexCacheStore(),
    )) ?? [[], 0]
    expect(entries).toEqual([
      ['/a.txt', 3],
      ['/sub/b.txt', 5],
    ])
    expect(total).toBe(8)
    expect(seen).toEqual([
      `${BASE}/root`,
      `${BASE}/root`,
      `${BASE}/root/children`,
      `${BASE}/root:/sub:/children`,
    ])
  })
})
