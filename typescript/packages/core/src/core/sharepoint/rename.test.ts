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
import { rename } from './rename.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SharePoint rename', () => {
  // Either side naming a site the tenant does not have fails before any
  // drive request, and the error names that side.
  it.each([
    ['Nope/Documents/a.txt', 'Team/Documents/b.txt', '/sp/Nope/Documents/a.txt'],
    ['Team/Documents/a.txt', 'Nope/Documents/b.txt', '/sp/Nope/Documents/b.txt'],
  ])('%s -> %s reports ENOENT for %s', async (src, dst, named) => {
    const fetchMock = vi.fn((input: unknown) => {
      const value = String(input).includes('/sites?')
        ? [{ id: 'site-id', displayName: 'Team' }]
        : [{ id: 'drive-id', name: 'Documents' }]
      return Promise.resolve(new Response(JSON.stringify({ value })))
    })
    vi.stubGlobal('fetch', fetchMock)
    const error: unknown = await rename(
      new SharePointAccessor({ accessToken: 'token' }),
      PathSpec.fromStrPath(`/sp/${src}`, src),
      PathSpec.fromStrPath(`/sp/${dst}`, dst),
    ).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'ENOENT', virtualPath: named })
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/drives/'))).toBe(true)
  })
})
