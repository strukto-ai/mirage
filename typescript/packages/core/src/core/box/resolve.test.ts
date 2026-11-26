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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BoxAccount } from '../../../tests/core/box/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { mountRelativeKey, resolveChain, resolveItem } from './resolve.ts'

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

// `team/docs` and `a.txt` at the root.
async function tree(): Promise<{ team: string; docs: string; a: string }> {
  const team = await account.mkdir('team')
  return {
    team,
    docs: await account.mkdir('docs', team),
    a: await account.put('a.txt', new Uint8Array([97])),
  }
}

describe('box resolve', () => {
  it('stops the chain at the first missing component', async () => {
    const ids = await tree()
    const chain = await resolveChain(account.accessor(), ['team', 'gone', 'x'])
    expect(chain.map((c) => c.id)).toEqual([ids.team])
  })

  it('never lists a file', async () => {
    const ids = await tree()
    await account.run.recordRequests()
    const chain = await resolveChain(account.accessor(), ['a.txt', 'x'])
    expect(chain.map((c) => c.id)).toEqual([ids.a])
    expect(await account.run.requests()).toEqual(['GET /2.0/folders/0/items'])
  })

  it('resolves an item only for the whole path', async () => {
    const ids = await tree()
    const accessor = account.accessor()
    expect((await resolveItem(accessor, ['team', 'docs']))?.id).toBe(ids.docs)
    expect((await resolveItem(accessor, ['a.txt']))?.id).toBe(ids.a)
    expect(await resolveItem(accessor, ['team', 'gone'])).toBeNull()
    expect(await resolveItem(accessor, ['a.txt', 'x'])).toBeNull()
    expect(await resolveItem(accessor, [])).toBeNull()
  })

  it('trims a path_collection through the mount root', () => {
    const item = {
      name: 'a.txt',
      path_collection: {
        total_count: 3,
        entries: [
          { type: 'folder' as const, id: '0', name: 'All Files' },
          { type: 'folder' as const, id: '10', name: 'team' },
          { type: 'folder' as const, id: '11', name: 'docs' },
        ],
      },
    }
    expect(mountRelativeKey(item, '0')).toBe('team/docs/a.txt')
    expect(mountRelativeKey(item, '10')).toBe('docs/a.txt')
    expect(mountRelativeKey(item, '99')).toBeNull()
  })
})
