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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { PathSpec } from '../../types.ts'
import { ManualClock } from '../../utils/clock.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import { serve, type JsonValue } from '../../../tests/fixtures/kit_fake.ts'
import { FILES, GoogleAccount, UNTIL_CLEARED } from '../../../tests/core/google/account.ts'
import { readdir } from './readdir.ts'
import { filesContaining } from './search.ts'
import { PARENTS_PER_QUERY } from './tree.ts'

const TIMEOUT = 0.2

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(() => {
  account = new GoogleAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function scope(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/gd' : `/gd/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath, resolved: false })
}

async function ask(
  under: PathSpec,
  accessor = account.driveAccessor(),
): Promise<PathSpec[] | null> {
  return filesContaining(accessor, 'wombat', under, await entryAt(readdir, accessor, under))
}

/** The folders each full-text search since recording started asked in. */
async function searched(): Promise<string[][]> {
  return (await account.listings()).filter((l) => l.text !== null).map((l) => l.folders)
}

describe('gdrive filesContaining', () => {
  it('answers the walked files Drive names', async () => {
    const sub = await account.folder('sub')
    await account.upload('a.txt', 'the wombat')
    await account.upload('b.txt', 'wombat here', sub)
    await account.upload('c.txt', 'nothing')
    await account.run.recordRequests()
    const out = await ask(scope())
    expect(out?.map((p) => p.virtual).sort()).toEqual(['/gd/a.txt', '/gd/sub/b.txt'])
    expect(await searched()).toEqual([['root', sub]])
  })

  it('searches a subfolder scope from its folder', async () => {
    const sub = await account.folder('sub')
    await account.upload('a.txt', 'wombat')
    await account.upload('b.txt', 'wombat', sub)
    const accessor = account.driveAccessor()
    const under = scope('sub')
    const entry = await entryAt(readdir, accessor, under)
    await account.run.recordRequests()
    const out = await filesContaining(accessor, 'wombat', under, entry)
    expect(out?.map((p) => [p.virtual, p.vfsPath])).toEqual([['/gd/sub/b.txt', 'sub/b.txt']])
    expect(await searched()).toEqual([[sub]])
  })

  it('searches many folders in batches', async () => {
    for (let i = 0; i < PARENTS_PER_QUERY + 5; i++) {
      await account.folder(`d${String(i).padStart(2, '0')}`)
    }
    await account.upload('a.txt', 'wombat')
    await account.run.recordRequests()
    expect(await ask(scope())).not.toBeNull()
    expect((await searched()).map((s) => s.length)).toEqual([PARENTS_PER_QUERY, 6])
  })

  it.each([
    'no hit',
    'an incomplete search',
    'a failed search',
    'a timed-out search',
    'a failed listing',
  ])('answers null for %s', async (name) => {
    await account.upload('a.txt', name === 'no hit' ? 'nothing' : 'wombat')
    if (name !== 'no hit') {
      // A run that answers learns the query each request is asked with, so
      // the one refused is that request and no other.
      await account.run.recordRequests()
      expect(await ask(scope())).not.toBeNull()
      const listings = await account.listings()
      const search = listings.find((l) => l.text !== null)
      const level = listings.find((l) => l.level && l.text === null)
      if (search === undefined || level === undefined) throw new Error('no search was asked')
      if (name === 'an incomplete search') {
        // Drive gave up on a corpus: its own answer, marked so.
        const asked = await account.run.call<Record<string, JsonValue>>(
          'GET',
          `${FILES}?${search.query}`,
        )
        await account.run.answerNext(
          'GET',
          FILES,
          200,
          { ...asked, incompleteSearch: true },
          1,
          undefined,
          search.query,
        )
      } else {
        await account.run.answerNext(
          'GET',
          FILES,
          name === 'a failed search' ? null : 200,
          undefined,
          UNTIL_CLEARED,
          undefined,
          (name === 'a failed listing' ? level : search).query,
          name === 'a failed search' ? 0 : TIMEOUT * 5000,
        )
      }
    }
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const accessor: GDriveAccessor = account.driveAccessor(new ManualClock(), {
      timeout: TIMEOUT,
    })
    expect(await ask(scope(), accessor)).toBeNull()
  })
})
