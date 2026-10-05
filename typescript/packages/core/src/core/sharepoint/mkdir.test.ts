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
import { PathSpec } from '../../types.ts'
import { mkdir } from './mkdir.ts'

const API = 'https://graph.microsoft.com/v1.0'
const DRIVE = `${API}/drives/drive-1`
const NOT_FOUND = { error: { code: 'itemNotFound', message: 'x' } }
const GETS: Record<string, unknown> = {
  [`${API}/sites`]: { value: [{ id: 'site-1', displayName: 'Engineering' }] },
  [`${API}/sites/site-1/drives`]: { value: [{ id: 'drive-1', name: 'Documents' }] },
}

// Records every folder create and answers each URL from a queue, so the
// first create of a URL can 404 and its retry succeed. A GET answers the
// site and drive lookups, then `items`, and 404s anything else.
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
        const found = GETS[url] ?? items[url]
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

describe('SharePoint mkdir under a mount root the drive does not have yet', () => {
  const scoped = (): SharePointAccessor =>
    new SharePointAccessor({
      accessToken: 'token',
      site: 'Engineering',
      drive: 'Documents',
      keyPrefix: 'team/root',
    })

  it('creates the root, then the folder', async () => {
    const posts = folderFetch({ [`${DRIVE}/root:/team/root:/children`]: [404] })
    await mkdir(scoped(), PathSpec.fromStrPath('/sp/lt', 'lt'))
    expect(posts).toEqual([
      `404 ${DRIVE}/root:/team/root:/children`,
      `201 ${DRIVE}/root/children`,
      `201 ${DRIVE}/root:/team:/children`,
      `201 ${DRIVE}/root:/team/root:/children`,
    ])
  })

  it.each([
    [true, '/sp'],
    [false, '/sp/lt'],
  ])('names a file in the hidden prefix as the root (parents=%s)', async (parents, named) => {
    folderFetch(
      { [`${DRIVE}/root:/team/root:/children`]: [404], [`${DRIVE}/root/children`]: [409] },
      { [`${DRIVE}/root:/team`]: { file: {} } },
    )
    await expect(
      mkdir(scoped(), PathSpec.fromStrPath('/sp/lt', 'lt'), parents),
    ).rejects.toMatchObject({ code: 'ENOTDIR', virtualPath: named })
  })

  it('does not retry a 404 below the mount root', async () => {
    const posts = folderFetch({ [`${DRIVE}/root:/team/root/a:/children`]: [404] })
    await expect(mkdir(scoped(), PathSpec.fromStrPath('/sp/a/b', 'a/b'))).rejects.toThrow()
    expect(posts).toEqual([`404 ${DRIVE}/root:/team/root/a:/children`])
  })
})

describe('SharePoint mkdir names a refusal', () => {
  const plain = (): SharePointAccessor => new SharePointAccessor({ accessToken: 'token' })

  // A folder another client made after the doors looked still 409s, and
  // only -p passes it.
  it.each([
    [{ folder: {} }, false, 'EEXIST'],
    [{ folder: {} }, true, null],
    [{ file: {} }, false, 'EEXIST'],
  ])('a 409 on %j with parents=%s is %s', async (taken, parents, code) => {
    folderFetch({ [`${DRIVE}/root/children`]: [409] }, { [`${DRIVE}/root:/new`]: taken })
    const made = mkdir(
      plain(),
      PathSpec.fromStrPath('/sp/Engineering/Documents/new', 'Engineering/Documents/new'),
      parents,
    )
    if (code === null) await expect(made).resolves.toBeUndefined()
    else await expect(made).rejects.toMatchObject({ code })
  })

  it.each([
    ['f/x/y', 'ENOTDIR'],
    ['f', 'EEXIST'],
  ])('mkdir -p %s names the file it stops at', async (rel, code) => {
    folderFetch({ [`${DRIVE}/root/children`]: [409] }, { [`${DRIVE}/root:/f`]: { file: {} } })
    const path = PathSpec.fromStrPath(
      `/sp/Engineering/Documents/${rel}`,
      `Engineering/Documents/${rel}`,
    )
    await expect(mkdir(plain(), path, true)).rejects.toMatchObject({
      code,
      virtualPath: '/sp/Engineering/Documents/f',
    })
  })

  it('a create under a file is ENOTDIR', async () => {
    folderFetch({ [`${DRIVE}/root:/f:/children`]: [404] }, { [`${DRIVE}/root:/f`]: { file: {} } })
    await expect(
      mkdir(
        plain(),
        PathSpec.fromStrPath('/sp/Engineering/Documents/f/new', 'Engineering/Documents/f/new'),
      ),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
