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
import { runWithCacheManager, type CacheInvalidator } from '../../cache/context.ts'
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

const FILE = { id: '1', file: {} }
const CONFLICT = { error: { code: 'nameAlreadyExists', message: 'x' } }

function recorder(): [CacheInvalidator, string[]] {
  const seen: string[] = []
  const manager = {
    invalidateAfterUnlink: (path: PathSpec) => {
      seen.push(`unlink ${path.virtual}`)
      return Promise.resolve()
    },
    invalidateSubtree: (path: PathSpec) => {
      seen.push(`subtree ${path.virtual}`)
      return Promise.resolve()
    },
  } as unknown as CacheInvalidator
  return [manager, seen]
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

// Site and drive lookups answer from the tenant listing; every drive
// request takes the next reply queued for its method.
function graph(replies: Record<string, Response[]>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/sites?'))
        return Promise.resolve(json({ value: [{ id: 'site-id', displayName: 'Team' }] }))
      if (url.includes('/drives?'))
        return Promise.resolve(json({ value: [{ id: 'drive-id', name: 'Documents' }] }))
      const next = replies[init?.method ?? 'GET']?.shift()
      if (next === undefined) throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
      return Promise.resolve(next)
    }),
  )
}

async function moved(dst: string): Promise<string[]> {
  const [manager, seen] = recorder()
  await runWithCacheManager(manager, () =>
    rename(
      new SharePointAccessor({ accessToken: 'token' }),
      PathSpec.fromStrPath('/sp/Team/Documents/a', 'Team/Documents/a'),
      PathSpec.fromStrPath(`/sp/Team/Documents/${dst}`, `Team/Documents/${dst}`),
    ),
  )
  return seen
}

// The conflict path: dst is fetched, emptied if a folder, and deleted.
function replaced(destination: unknown): Record<string, Response[]> {
  return {
    PATCH: [json(CONFLICT, 409), json(FILE)],
    GET: [json(destination), json({ value: [] })],
    DELETE: [new Response(null, { status: 204 })],
  }
}

describe('SharePoint rename invalidation', () => {
  const at = (name: string): string => `/sp/Team/Documents/${name}`

  it.each([
    ['a file', () => ({ PATCH: [json(FILE)] }), [`unlink ${at('b')}`, `unlink ${at('a')}`]],
    [
      'a folder',
      () => ({ PATCH: [json({ id: '1', folder: { childCount: 2 } })] }),
      [`subtree ${at('b')}`, `subtree ${at('a')}`],
    ],
    [
      'a file over an empty folder',
      () => replaced({ id: '2', folder: {} }),
      [`subtree ${at('b')}`, `unlink ${at('a')}`],
    ],
  ])('%s', async (_label, replies, drops) => {
    // The PATCH reply names what moved: only a file facet spares the
    // subtree. A destination the move replaced keeps its subtree unless
    // that was positively a file: its name may still have cached children
    // removed outside mirage.
    graph(replies())
    expect(await moved('b')).toEqual(drops)
  })
})
