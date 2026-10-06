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
import { mkdir } from './mkdir.ts'

const BASE = 'https://graph.microsoft.com/v1.0/me/drive'
const NOT_FOUND = { error: { code: 'itemNotFound', message: 'x' } }

// Records every folder create and answers each URL from a queue, so the
// first create of a URL can 404 and its retry succeed.
// Records every folder create and answers each URL from a queue; a GET
// answers from `items` and 404s anything else.
function folderFetch(
  answers: Record<string, number[]>,
  items: Record<string, unknown> = {},
): string[] {
  const posts: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = (String(input).split('?')[0] ?? '').replace(/\/$/, '')
      if ((init?.method ?? 'GET') === 'GET') {
        const found = items[url]
        if (found === undefined) {
          return Promise.resolve(new Response(JSON.stringify(NOT_FOUND), { status: 404 }))
        }
        return Promise.resolve(new Response(JSON.stringify(found)))
      }
      const status = answers[url]?.shift() ?? 201
      posts.push(`${String(status)} ${url}`)
      const body = status < 400 ? { id: '1' } : NOT_FOUND
      return Promise.resolve(new Response(JSON.stringify(body), { status }))
    }),
  )
  return posts
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OneDrive mkdir under a mount root the drive does not have yet', () => {
  const scoped = (): OneDriveAccessor =>
    new OneDriveAccessor({ accessToken: 'token', keyPrefix: 'team/root' })

  it.each([false, true])('creates the root, then the folder (parents=%s)', async (parents) => {
    const posts = folderFetch({ [`${BASE}/root:/team/root:/children`]: [404] })
    await mkdir(scoped(), PathSpec.fromStrPath('/od/lt', 'lt'), parents)
    expect(posts).toEqual([
      `404 ${BASE}/root:/team/root:/children`,
      `201 ${BASE}/root/children`,
      `201 ${BASE}/root:/team:/children`,
      `201 ${BASE}/root:/team/root:/children`,
    ])
  })

  it.each([
    [true, '/od'],
    [false, '/od/lt'],
  ])('names a file in the hidden prefix as the root (parents=%s)', async (parents, named) => {
    folderFetch(
      { [`${BASE}/root:/team/root:/children`]: [404], [`${BASE}/root/children`]: [409] },
      { [`${BASE}/root:/team`]: { file: {} } },
    )
    await expect(
      mkdir(scoped(), PathSpec.fromStrPath('/od/lt', 'lt'), parents),
    ).rejects.toMatchObject({ code: 'ENOTDIR', virtualPath: named })
  })

  it.each([
    ['below the mount root', scoped, 'a/b', `${BASE}/root:/team/root/a:/children`],
    [
      'without a key prefix',
      () => new OneDriveAccessor({ accessToken: 'token' }),
      'new',
      `${BASE}/root/children`,
    ],
  ])('does not retry a 404 %s', async (_case, accessor, key, url) => {
    const posts = folderFetch({ [url]: [404] })
    await expect(mkdir(accessor(), PathSpec.fromStrPath(`/od/${key}`, key))).rejects.toThrow()
    expect(posts).toEqual([`404 ${url}`])
  })
})

describe('OneDrive mkdir names a refusal', () => {
  const plain = (): OneDriveAccessor => new OneDriveAccessor({ accessToken: 'token' })

  // A folder another client made after the doors looked still 409s, and
  // only -p passes it.
  it.each([
    [{ folder: {} }, false, 'EEXIST'],
    [{ folder: {} }, true, null],
    [{ file: {} }, false, 'EEXIST'],
  ])('a 409 on %j with parents=%s is %s', async (taken, parents, code) => {
    folderFetch(
      { [`${BASE}/root:/parent:/children`]: [409] },
      { [`${BASE}/root:/parent/new`]: taken },
    )
    const made = mkdir(plain(), PathSpec.fromStrPath('/od/parent/new', 'parent/new'), parents)
    if (code === null) await expect(made).resolves.toBeUndefined()
    else await expect(made).rejects.toMatchObject({ code })
  })

  it.each([
    ['/od/f/x/y', 'f/x/y', 'ENOTDIR'],
    ['/od/f', 'f', 'EEXIST'],
  ])('mkdir -p %s names the file it stops at', async (virtual, key, code) => {
    folderFetch({ [`${BASE}/root/children`]: [409] }, { [`${BASE}/root:/f`]: { file: {} } })
    await expect(mkdir(plain(), PathSpec.fromStrPath(virtual, key), true)).rejects.toMatchObject({
      code,
      virtualPath: '/od/f',
    })
  })

  it('a create under a file is ENOTDIR', async () => {
    folderFetch({ [`${BASE}/root:/f:/children`]: [404] }, { [`${BASE}/root:/f`]: { file: {} } })
    await expect(mkdir(plain(), PathSpec.fromStrPath('/od/f/new', 'f/new'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })
})
