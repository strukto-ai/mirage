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
import { runWithCacheManager, type CacheInvalidator } from '../../cache/context.ts'
import { PathSpec } from '../../types.ts'
import { rename } from './rename.ts'

const FILE = { id: '1', file: {} }
const CONFLICT = { error: { code: 'nameAlreadyExists', message: 'x' } }

afterEach(() => {
  vi.unstubAllGlobals()
})

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

// One queue per method: each request takes the next reply for its method.
function graph(replies: Record<string, Response[]>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: unknown, init?: RequestInit) => {
      const next = replies[init?.method ?? 'GET']?.shift()
      if (next === undefined) throw new Error(`unexpected ${init?.method ?? 'GET'}`)
      return Promise.resolve(next)
    }),
  )
}

async function moved(dst: string): Promise<string[]> {
  const [manager, seen] = recorder()
  await runWithCacheManager(manager, () =>
    rename(
      new OneDriveAccessor({ accessToken: 'token' }),
      PathSpec.fromStrPath('/a'),
      PathSpec.fromStrPath(dst),
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

describe('OneDrive rename invalidation', () => {
  it.each([
    ['a file', () => ({ PATCH: [json(FILE)] }), ['unlink /b', 'unlink /a']],
    [
      'a folder',
      () => ({ PATCH: [json({ id: '1', folder: { childCount: 2 } })] }),
      ['subtree /b', 'subtree /a'],
    ],
    ['an unnamed item', () => ({ PATCH: [json({ id: '1' })] }), ['subtree /b', 'subtree /a']],
    ['a null reply', () => ({ PATCH: [json(null)] }), ['subtree /b', 'subtree /a']],
    [
      'a file over an empty folder',
      () => replaced({ id: '2', folder: {} }),
      ['subtree /b', 'unlink /a'],
    ],
    [
      'a file over an item of no known kind',
      () => replaced({ id: '2' }),
      ['subtree /b', 'unlink /a'],
    ],
    ['a file over a file', () => replaced({ id: '2', file: {} }), ['unlink /b', 'unlink /a']],
  ])('%s', async (_label, replies, drops) => {
    // The PATCH reply names what moved: only a file facet spares the
    // subtree. A destination the move replaced keeps its subtree unless
    // that was positively a file: its name may still have cached children
    // removed outside mirage.
    graph(replies())
    expect(await moved('/b')).toEqual(drops)
  })
})
