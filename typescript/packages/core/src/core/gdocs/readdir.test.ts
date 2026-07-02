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

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  return { ...actual, listAllFiles: vi.fn() }
})

import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { TokenManager } from '../google/_client.ts'
import * as drive from '../google/drive.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

const STUB_TOKEN_MANAGER = {} as TokenManager

function makeAccessor(): GDocsAccessor {
  return new GDocsAccessor({ tokenManager: STUB_TOKEN_MANAGER })
}

describe('gdocs readdir', () => {
  it('pushes modified range to drive when pattern is a date glob', async () => {
    const captured: { modifiedAfter?: string | null; modifiedBefore?: string | null } = {}
    vi.mocked(drive.listAllFiles).mockImplementation(((_tm, opts) => {
      captured.modifiedAfter = opts?.modifiedAfter ?? null
      captured.modifiedBefore = opts?.modifiedBefore ?? null
      return Promise.resolve([])
    }) as typeof drive.listAllFiles)

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/owned/2026-05-*',
        directory: '/gdocs/owned',
        pattern: '2026-05-*',
        resourcePath: mountKey('/gdocs/owned/2026-05-*', '/gdocs'),
      }),
      index,
    )

    expect(captured.modifiedAfter).toBe('2026-05-01T00:00:00Z')
    expect(captured.modifiedBefore).toBe('2026-06-01T00:00:00Z')
  })

  it('omits modified range when no pattern', async () => {
    const captured: { modifiedAfter?: string | null; modifiedBefore?: string | null } = {}
    vi.mocked(drive.listAllFiles).mockImplementation(((_tm, opts) => {
      captured.modifiedAfter = opts?.modifiedAfter ?? null
      captured.modifiedBefore = opts?.modifiedBefore ?? null
      return Promise.resolve([])
    }) as typeof drive.listAllFiles)

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/owned',
        directory: '/gdocs/owned',
        resourcePath: mountKey('/gdocs/owned', '/gdocs'),
      }),
      index,
    )

    expect(captured.modifiedAfter).toBeNull()
    expect(captured.modifiedBefore).toBeNull()
  })

  it('omits modified range for non-date pattern', async () => {
    const captured: { modifiedAfter?: string | null; modifiedBefore?: string | null } = {}
    vi.mocked(drive.listAllFiles).mockImplementation(((_tm, opts) => {
      captured.modifiedAfter = opts?.modifiedAfter ?? null
      captured.modifiedBefore = opts?.modifiedBefore ?? null
      return Promise.resolve([])
    }) as typeof drive.listAllFiles)

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/owned/*foo*',
        directory: '/gdocs/owned',
        pattern: '*foo*',
        resourcePath: mountKey('/gdocs/owned/*foo*', '/gdocs'),
      }),
      index,
    )

    expect(captured.modifiedAfter).toBeNull()
    expect(captured.modifiedBefore).toBeNull()
  })

  it('filtered listing does not clobber unfiltered cache', async () => {
    const full = [
      {
        id: 'may',
        name: 'MayDoc',
        modifiedTime: '2026-05-15T00:00:00.000Z',
        owners: [{ me: true }],
      },
      {
        id: 'jan',
        name: 'JanDoc',
        modifiedTime: '2026-01-15T00:00:00.000Z',
        owners: [{ me: true }],
      },
    ]
    const mayOnly = full.slice(0, 1)
    let calls = 0
    vi.mocked(drive.listAllFiles).mockImplementation(((_tm, opts) => {
      calls += 1
      if (opts?.modifiedAfter) return Promise.resolve(mayOnly)
      return Promise.resolve(full)
    }) as typeof drive.listAllFiles)

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/owned/2026-05-*',
        directory: '/gdocs/owned',
        pattern: '2026-05-*',
        resourcePath: mountKey('/gdocs/owned/2026-05-*', '/gdocs'),
      }),
      index,
    )
    const result = await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/owned',
        directory: '/gdocs/owned',
        resourcePath: mountKey('/gdocs/owned', '/gdocs'),
      }),
      index,
    )
    expect(calls).toBe(2)
    expect(result.length).toBe(2)
  })

  it('filtered listing populates per-entry index so stat succeeds', async () => {
    vi.mocked(drive.listAllFiles).mockResolvedValue([
      {
        id: 'may1',
        name: 'MayDoc',
        modifiedTime: '2026-05-15T00:00:00.000Z',
        owners: [{ me: false }],
      },
    ])

    const accessor = makeAccessor()
    const index = new RAMIndexCacheStore()
    const listed = await readdir(
      accessor,
      new PathSpec({
        virtual: '/gdocs/shared/2026-05-*',
        directory: '/gdocs/shared',
        pattern: '2026-05-*',
        resourcePath: mountKey('/gdocs/shared/2026-05-*', '/gdocs'),
      }),
      index,
    )
    expect(listed.length).toBe(1)
    const matched = listed[0]
    if (matched === undefined) throw new Error('expected one match')
    const result = await stat(
      accessor,
      new PathSpec({
        virtual: matched,
        directory: matched,
        resourcePath: mountKey(matched, '/gdocs'),
      }),
      index,
    )
    expect(result.extra.doc_id).toBe('may1')
  })
})
