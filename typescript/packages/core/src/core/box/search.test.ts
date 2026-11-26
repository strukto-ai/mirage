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

// Mirror of python/tests/core/box/test_search.py.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PathSpec } from '../../types.ts'
import type { JsonValue } from '../../types.ts'
import { BoxAccount } from '../../../tests/core/box/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import { readdir } from './readdir.ts'
import { filesContaining } from './search.ts'

const SEARCH_ROUTE = '/2.0/search'
const SEARCH_FIELDS = 'id,name,type,path_collection'
const NEEDLE = new TextEncoder().encode('a needle in it')

let origin: string
let account: BoxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('box')
}, 30_000)

beforeEach(() => {
  account = new BoxAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function mountRoot(): PathSpec {
  return new PathSpec({ virtual: '/data', directory: '/data', vfsPath: '' })
}

// The folder the one search since recording was scoped to.
async function scopeOf(): Promise<string | undefined> {
  const sent = await account.run.params('GET', SEARCH_ROUTE)
  expect(sent).toHaveLength(1)
  return sent[0]?.ancestor_folder_ids
}

describe('filesContaining', () => {
  // A mount rooted at /data, given Box's answer for the whole account: the
  // hit in another folder is no path under the mount.
  it('names each hit from its path_collection', async () => {
    const data = await account.mkdir('data')
    await account.put('x.txt', NEEDLE, data)
    const sub = await account.mkdir('Sub', data)
    await account.put('y.txt', NEEDLE, sub)
    await account.put('out.txt', NEEDLE, await account.mkdir('Elsewhere'))
    const everywhere = await account.run.call<{ entries: JsonValue[] }>(
      'GET',
      `/2.0/search?query=needle&type=file&fields=${SEARCH_FIELDS}`,
    )
    expect(everywhere.entries).toHaveLength(3)
    await account.run.answerNext('GET', SEARCH_ROUTE, 200, everywhere)
    await account.run.recordRequests()
    const out = await filesContaining(account.accessor(data), 'needle', mountRoot())
    expect(await scopeOf()).toBe(data)
    expect(out?.map((p) => [p.virtual, p.vfsPath]).sort()).toEqual([
      ['/data/Sub/y.txt', 'Sub/y.txt'],
      ['/data/x.txt', 'x.txt'],
    ])
  })

  it('searches a subfolder scope under its folder id', async () => {
    const docs = await account.mkdir('docs')
    await account.put('in.txt', NEEDLE, docs)
    await account.put('top.txt', NEEDLE)
    const scope = new PathSpec({
      virtual: '/data/docs',
      directory: '/data/docs',
      vfsPath: 'docs',
    })
    const accessor = account.accessor()
    const row = await entryAt(readdir, accessor, scope)
    await account.run.recordRequests()
    const out = await filesContaining(accessor, 'needle', scope, row)
    expect(await scopeOf()).toBe(docs)
    expect(out?.map((p) => [p.virtual, p.vfsPath])).toEqual([['/data/docs/in.txt', 'docs/in.txt']])
  })

  // No hit is distrusted too: Box indexes a write after it lands.
  it.each(['an API failure', 'a truncated answer', 'no hit'])('is null for %s', async (answer) => {
    await account.put('x.txt', NEEDLE)
    if (answer === 'an API failure') await account.run.answerNext('GET', SEARCH_ROUTE, 500)
    if (answer === 'a truncated answer') {
      const page = await account.run.call<{ entries: JsonValue[] } & Record<string, JsonValue>>(
        'GET',
        `/2.0/search?query=needle&fields=${SEARCH_FIELDS}`,
      )
      const entries = Array.from({ length: 200 }, () => page.entries[0] ?? null)
      await account.run.answerNext(
        'GET',
        SEARCH_ROUTE,
        200,
        { ...page, total_count: 20_000, entries },
        60,
      )
    }
    const query = answer === 'no hit' ? 'absent' : 'needle'
    expect(await filesContaining(account.accessor(), query, mountRoot())).toBeNull()
  })

  it('is null for a scope that is no folder', async () => {
    await account.put('a.txt', NEEDLE)
    const scope = new PathSpec({
      virtual: '/data/a.txt',
      directory: '/data/a.txt',
      vfsPath: 'a.txt',
    })
    const accessor = account.accessor()
    const row = await entryAt(readdir, accessor, scope)
    await account.run.recordRequests()
    expect(await filesContaining(accessor, 'needle', scope, row)).toBeNull()
    expect(await account.run.requests()).toEqual([])
  })
})
