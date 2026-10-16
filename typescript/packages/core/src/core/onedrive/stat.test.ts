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
import { readdir } from './readdir.ts'
import { stat, tree } from './stat.ts'

function answer(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OneDrive stat', () => {
  // A folder's `size` is Graph's aggregate subtree storage number, not
  // rendered content length, the mount root's included.
  it.each([
    ['/od/Docs', 'Docs'],
    ['/od', ''],
  ])('keeps the aggregate size of %s out of FileStat.size', async (virtual, key) => {
    answer({ id: 'folder', name: 'Docs', size: 4096, folder: { childCount: 2 } })
    const info = await stat(
      new OneDriveAccessor({ accessToken: 'token' }),
      PathSpec.fromStrPath(virtual, key),
    )
    expect(info.size).toBeNull()
    expect(info.extra).toMatchObject({ size_bytes: 4096, child_count: 2 })
  })

  it('lists a folder without a fingerprint', async () => {
    answer({
      value: [{ id: 'dir', name: 'Docs', cTag: 'ctag-dir', folder: { childCount: 1 } }],
    })
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    const [docs] = await readdir(accessor, PathSpec.fromStrPath('/od', ''))
    expect(docs?.type).toBe('directory')
    expect(docs?.fingerprint).toBeNull()
  })
})

const ME = 'https://graph.microsoft.com/v1.0/me/drive'

function query(url: string, select: string): string {
  const target = new URL(url)
  target.searchParams.set('$select', select)
  return target.toString()
}

// Each URL answers its body, a refused one 403; any other request fails the
// test. Each JSON body sent is kept in `sent`.
function routes(
  bodies: Record<string, unknown>,
  refused: readonly string[] = [],
  sent: unknown[] = [],
): string[] {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input)
      asked.push(url)
      if (typeof init?.body === 'string') sent.push(JSON.parse(init.body))
      if (refused.includes(url)) {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 403 }))
      }
      if (!(url in bodies)) throw new Error(`unstubbed request: ${url}`)
      return Promise.resolve(new Response(JSON.stringify(bodies[url]), { status: 200 }))
    }),
  )
  return asked
}

const BATCH = 'https://graph.microsoft.com/v1.0/$batch'

const FEED = [
  { id: 'R', name: 'root', root: {}, folder: {} },
  { id: 'D', name: 'Docs', parentReference: { id: 'R' }, folder: { childCount: 1 } },
  {
    id: 'f',
    name: 'report.docx',
    parentReference: { id: 'D' },
    size: 4,
    file: {},
    cTag: 'c-report',
  },
]

describe('OneDrive tree', () => {
  it('reads the feed of a personal drive root in one read', async () => {
    routes({
      [query(ME, 'driveType')]: { driveType: 'personal' },
      [query(`${ME}/root`, 'id,folder')]: { id: 'R', folder: {} },
      [`${ME}/root/delta`]: { value: FEED },
    })
    const found = await tree(
      new OneDriveAccessor({ accessToken: 'token' }),
      PathSpec.fromStrPath('/od', ''),
    )
    expect([...(found?.keys() ?? [])].sort()).toEqual(['Docs', 'Docs/report.docx'])
    expect(found?.get('Docs/report.docx')?.size).toBe(4)
    expect(found?.get('Docs/report.docx')?.fingerprint).toBe('c-report')
  })

  it('reads the feed below the root of a personal drive', async () => {
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    routes({
      [query(ME, 'driveType')]: { driveType: 'personal' },
      [query(`${ME}/root:/Docs`, 'id,folder')]: { id: 'D', folder: {} },
      [`${ME}/root:/Docs:/delta`]: { value: FEED.slice(1) },
    })
    const found = await tree(accessor, PathSpec.fromStrPath('/od/Docs', 'Docs'))
    expect([...(found?.keys() ?? [])]).toEqual(['report.docx'])
    expect(accessor.driveType).toBe('personal')
  })

  it.each(['business', 'documentLibrary'])('batches the folders of a %s drive', async (kind) => {
    const sent: unknown[] = []
    routes(
      {
        [query(ME, 'driveType')]: { driveType: kind },
        [`${ME}/root/children`]: { value: [FEED[1]] },
        [BATCH]: { responses: [{ id: '0', status: 200, body: { value: [FEED[2]] } }] },
      },
      [],
      sent,
    )
    const found = await tree(
      new OneDriveAccessor({ accessToken: 'token' }),
      PathSpec.fromStrPath('/od', ''),
    )
    expect([...(found?.keys() ?? [])].sort()).toEqual(['Docs', 'Docs/report.docx'])
    expect(found?.get('Docs/report.docx')?.fingerprint).toBe('c-report')
    expect(sent).toEqual([
      { requests: [{ id: '0', method: 'GET', url: '/me/drive/root:/Docs:/children' }] },
    ])
  })

  it('batches while the drive type is refused', async () => {
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    routes({ [`${ME}/root:/Docs:/children`]: { value: [FEED[2]] } }, [query(ME, 'driveType')])
    const found = await tree(accessor, PathSpec.fromStrPath('/od/Docs', 'Docs'))
    expect([...(found?.keys() ?? [])]).toEqual(['report.docx'])
    expect(accessor.driveType).toBeNull()
  })

  it('batches a personal drive whose feed is refused', async () => {
    routes(
      {
        [query(ME, 'driveType')]: { driveType: 'personal' },
        [query(`${ME}/root:/Docs`, 'id,folder')]: { id: 'D', folder: {} },
        [`${ME}/root:/Docs:/children`]: { value: [FEED[2]] },
      },
      [`${ME}/root:/Docs:/delta`],
    )
    const found = await tree(
      new OneDriveAccessor({ accessToken: 'token' }),
      PathSpec.fromStrPath('/od/Docs', 'Docs'),
    )
    expect([...(found?.keys() ?? [])]).toEqual(['report.docx'])
  })
})
