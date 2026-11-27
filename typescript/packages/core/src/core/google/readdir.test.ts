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
import { GoogleApiAccessor } from '../../accessor/google_api.ts'
import { PathSpec, type DirListing, type FileStat } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { MIME } from '../gsheets/constants.ts'
import { detectScope } from '../gsheets/scope.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { FILES, GoogleAccount, type DriveListing } from '../../../tests/core/google/account.ts'
import { makeAppReaddir } from './readdir.ts'

const READDIR = makeAppReaddir(
  MIME,
  detectScope,
  (title, fileId, modified) => `${title}.${fileId}.${modified.slice(0, 4)}`,
)

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

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, '/m') })
}

function accessor(): GoogleApiAccessor {
  return new GoogleApiAccessor({ tokenManager: account.tokenManager() })
}

describe('makeAppReaddir', () => {
  it("lists a corpus's own files through the app's namer", async () => {
    const mine = await account.create('Mine', MIME)
    await account.patch(mine, { modifiedTime: '2026-04-01T00:00:00.000Z' })
    const theirs = await account.create('Theirs', MIME)
    // Every file the fake holds is the account's own; Drive names another
    // owner for one shared with it, and gives a native file's size.
    const listing = await account.run.call<DriveListing>(
      'GET',
      `${FILES}?${new URLSearchParams({ q: `mimeType = '${MIME}'` }).toString()}`,
    )
    const files = listing.files.map((row) =>
      row.id === mine
        ? { ...row, size: '12' }
        : row.id === theirs
          ? { ...row, owners: [{ me: false }] }
          : row,
    )
    await account.run.answerNext('GET', FILES, 200, { ...listing, files })
    await account.run.recordRequests()
    const out = (await READDIR(accessor(), spec('/m/owned'))) as DirListing
    expect(out.partial).toBe(false)
    expect(out.entries.map((row) => row.name)).toEqual([`Mine.${mine}.2026`])
    const [asked] = await account.asked('GET', FILES)
    expect(new URLSearchParams(asked?.query).get('q')).toContain(`mimeType='${MIME}'`)
    expect(out.entries[0]?.size).toBeNull()
    expect(out.entries[0]?.extra).toEqual({ doc_id: mine, doc_name: 'Mine', source_size: 12 })
  })

  it('lists the corpora at the root without a request', async () => {
    await account.run.recordRequests()
    const out = (await READDIR(accessor(), spec('/m'))) as FileStat[]
    expect(out.map((row) => row.name)).toEqual(['owned', 'shared'])
    expect(await account.log()).toEqual([])
  })
})
