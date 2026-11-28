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
import { GDocsAccessor } from '../../accessor/gdocs.ts'
import { recordingScope } from '../../observe/context.ts'
import { PathSpec, type FileStat } from '../../types.ts'
import { ManualClock } from '../../utils/clock.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { GDocsVFS } from '../../vfs/gdocs/gdocs.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import {
  FILE,
  FILES,
  GoogleAccount,
  UNTIL_CLEARED,
  type DriveListing,
} from '../../../tests/core/google/account.ts'
import { read } from './read.ts'

const APP = '/gdocs'
const MIME = 'application/vnd.google-apps.document'
const SUFFIX = '.gdoc.json'

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

function accessor(clock?: ManualClock): GDocsAccessor {
  return new GDocsAccessor({ tokenManager: account.tokenManager(clock) })
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, APP) })
}

/** Make a file of the app named `name`, stamped `stamp`, and answer its id. */
async function made(name: string, stamp: string): Promise<string> {
  const id = await account.create(name, MIME)
  await account.patch(id, { modifiedTime: stamp })
  return id
}

describe('gdocs read auto-bootstrap', () => {
  it('resolves a read no listing named by its id', async () => {
    const id = await made('Notes', '2026-04-01T00:00:00.000Z')
    await account.run.recordRequests()
    const out = await read(accessor(), spec(`${APP}/owned/2026-04-01_Notes__${id}${SUFFIX}`))
    expect(new TextDecoder().decode(out)).toContain(id)
    expect((await account.log()).map(([name]) => name)).toEqual(['get', 'GET /v1/documents/:id'])
  })

  it('throws ENOENT when file missing by ID', async () => {
    await account.run.recordRequests()
    await expect(
      read(accessor(), spec(`${APP}/owned/Missing__xyz${SUFFIX}`)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await account.log()).map(([name]) => name)).toEqual(['get'])
  })

  // The Drive-item read family (gdocs/gsheets/gslides) shares this shape:
  // only an absent parent may collapse into the operand's ENOENT.
  it('propagates a failed metadata request instead of reporting ENOENT', async () => {
    await account.refuse('GET', FILE, 503, 'google unavailable', {
      reason: 'backendError',
      times: UNTIL_CLEARED,
    })
    await account.run.recordRequests()
    await expect(
      read(accessor(new ManualClock()), spec(`${APP}/owned/Missing__xyz${SUFFIX}`)),
    ).rejects.toThrow(/google unavailable/)
    expect(new Set((await account.log()).map(([name]) => name))).toEqual(new Set(['get']))
  })
})

describe('gdocs read token', () => {
  // read: fresh compares this record with stat's fingerprint, so both take
  // the file's modified stamp, and a file without one stamps nothing.
  const cases: [string, string | null][] = [
    ['2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'],
    ['', null],
  ]
  for (const [stamp, token] of cases) {
    it(`records the token stat reports (stamp ${JSON.stringify(stamp)})`, async () => {
      const id = await made('My Doc', '2026-04-01T00:00:00.000Z')
      if (stamp === '') {
        // A file Drive gives no modified time: its own item without one, on
        // the listing and on the lookup.
        const listing = await account.run.call<DriveListing>(
          'GET',
          `${FILES}?${new URLSearchParams({ q: `mimeType = '${MIME}'` }).toString()}`,
        )
        const files = listing.files.map((row) =>
          row.id === id ? { ...row, modifiedTime: '' } : row,
        )
        await account.run.answerNext('GET', FILES, 200, { ...listing, files })
        const item = await account.item(id)
        await account.run.answerNext('GET', FILE, 200, { ...item, modifiedTime: '' }, 2)
      }
      const reader = accessor()
      const vfs = Object.assign(new GDocsVFS(account.config()), { accessor: reader })
      const ws = new Workspace({ [`${APP}/`]: vfs })
      const [target = ''] = (await ws.dispatch('readdir', `${APP}/owned`)) as string[]
      const [data, records] = await recordingScope(() => read(reader, spec(target)))
      const info = (await ws.dispatch('stat', target)) as FileStat
      expect(records.map((r) => [r.op, r.path, r.source, r.bytes, r.fingerprint])).toEqual([
        ['read', target, 'gdocs', data.byteLength, token],
      ])
      expect(info.fingerprint).toBe(token)
    })
  }
})
