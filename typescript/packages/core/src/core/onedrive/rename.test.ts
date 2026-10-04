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

const CONFLICT = { error: { code: 'nameAlreadyExists', message: 'x' } }

afterEach(() => {
  vi.unstubAllGlobals()
})

function recorder(): [CacheInvalidator, string[]] {
  const seen: string[] = []
  const manager = {
    invalidateAfterMove: (path: PathSpec, folder: boolean) => {
      seen.push(`${folder ? 'subtree' : 'unlink'} ${path.virtual}`)
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

describe('OneDrive rename invalidation', () => {
  it('a renamed file drops no subtree', async () => {
    // The PATCH reply names what moved: a file facet means nothing was
    // cached beneath either name.
    graph({ PATCH: [json({ id: '1', file: {} })] })
    expect(await moved('/b')).toEqual(['unlink /b', 'unlink /a'])
  })

  it.each([
    ['a folder', { id: '1', folder: { childCount: 2 } }],
    ['an unnamed item', { id: '1' }],
    ['a null reply', null],
  ])('%s drops both subtrees', async (_label, reply) => {
    // Only a positive file facet narrows: a reply that names no type, or a
    // literal `null` body after a move that worked, leaves both ends
    // dropping their subtrees.
    graph({ PATCH: [json(reply)] })
    expect(await moved('/b')).toEqual(['subtree /b', 'subtree /a'])
  })

  it('a file replacing an empty folder drops its subtree', async () => {
    // The rename deleted the folder at dst, so whatever is still cached
    // under that name (children removed outside mirage, say) goes too.
    graph({
      PATCH: [json(CONFLICT, 409), json({ id: '1', file: {} })],
      GET: [json({ id: '2', name: 'dst', folder: {} }), json({ value: [] })],
      DELETE: [new Response(null, { status: 204 })],
    })
    expect(await moved('/dst')).toEqual(['subtree /dst', 'unlink /a'])
  })

  it('a file replacing an item of no known kind drops its subtree', async () => {
    // Only a positive file facet on what was replaced keeps dst narrow.
    graph({
      PATCH: [json(CONFLICT, 409), json({ id: '1', file: {} })],
      GET: [json({ id: '2', name: 'dst' })],
      DELETE: [new Response(null, { status: 204 })],
    })
    expect(await moved('/dst')).toEqual(['subtree /dst', 'unlink /a'])
  })

  it('a file replacing a file drops no subtree', async () => {
    graph({
      PATCH: [json(CONFLICT, 409), json({ id: '1', file: {} })],
      GET: [json({ id: '2', name: 'dst', file: {} })],
      DELETE: [new Response(null, { status: 204 })],
    })
    expect(await moved('/dst')).toEqual(['unlink /dst', 'unlink /a'])
  })
})
