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
import { settling } from '../../cache/_test_util.ts'
import { write } from './write.ts'

// A key named like its mount: neither `m/k.txt` nor `/m/k.txt` is virtual.
const SPEC = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OneDrive write', () => {
  it('write PUTs the bytes and records a write', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'item' })))
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const [, records] = await runWithRecording(() =>
      write(accessor, SPEC, new TextEncoder().encode('hi')),
    )
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe('PUT')
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://graph.microsoft.com/v1.0/me/drive/root:/m/k.txt:/content',
    )
    expect(records).toMatchObject([
      { op: 'write', path: '/m/m/k.txt', source: 'onedrive', bytes: 2 },
    ])
  })
})

describe('OneDrive write settles with the upload reply', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

  for (const [reply, receipt] of [
    [
      { id: 'X', size: 7, cTag: 'c2' },
      { storedSize: 7, token: 'c2' },
    ],
    [{ id: 'X' }, { storedSize: null, token: null }],
  ] as const) {
    it(`hands the cache the stored size and cTag (${JSON.stringify(reply)})`, async () => {
      // The PUT answers the stored item: its size and cTag are what the drive
      // holds, which property promotion can make differ from the body.
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response(JSON.stringify(reply), { status: 201 }))),
      )
      const accessor = new OneDriveAccessor({ accessToken: 'token' })
      const manager = await settling(() => write(accessor, SPEC, enc('hello')))
      expect(manager.settled).toEqual([
        { path: '/m/m/k.txt', data: 'hello', receipt, generation: 5 },
      ])
      expect(manager.writes).toEqual([])
    })
  }

  it('a session upload settles with the final chunk reply', async () => {
    const replies = [
      { uploadUrl: 'https://upload.example/s' },
      { nextExpectedRanges: ['3276800-'] },
      { id: 'X', size: 9, cTag: 'c3' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(replies.shift()), { status: 201 }))),
    )
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const data = new Uint8Array(4 * 1024 * 1024 + 1)
    const manager = await settling(() => write(accessor, SPEC, data))
    expect(manager.settled.map((s) => [s.path, s.receipt, s.generation])).toEqual([
      ['/m/m/k.txt', { storedSize: 9, token: 'c3' }, 5],
    ])
  })
})

describe('OneDrive write notes the generation before its upload', () => {
  it('a change during the upload reaches settle', async () => {
    // The generation is noted before the upload, so a change of the mount
    // that lands while the PUT runs makes settle drop the bytes.
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const manager = await settling(async (recorder) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          recorder.generation = 6
          return Promise.resolve(new Response(JSON.stringify({ id: 'X' }), { status: 201 }))
        }),
      )
      await write(accessor, SPEC, new TextEncoder().encode('hello'))
    })
    expect(manager.settled.map((s) => s.generation)).toEqual([5])
  })
})
