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
import { DirListing, FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { GoogleAccount } from '../../../tests/core/google/account.ts'
import { readdir } from './readdir.ts'

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

// The account with Gmail's system labels and no message yet.
beforeEach(async () => {
  account = new GoogleAccount(origin)
  await account.reset()
})

afterEach(async () => {
  await account.run.close()
})

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, '/gmail') })
}

function row(name: string): FileStat {
  return new FileStat({ name, type: FileType.DIRECTORY, extra: { label_id: 'INBOX' } })
}

describe('gmail readdir windows', () => {
  let x1: string

  beforeEach(async () => {
    x1 = await account.message('Hi 27', 'hello', { date: 'Mon, 27 Apr 2026 00:00:00 +0000' })
  })

  it('lists a label as a window that seeds its days', async () => {
    // Both fetches stop at MAX_MESSAGES, so what they name is a window: a
    // message outside it has not gone anywhere.
    const listing = await readdir(account.gmailAccessor(), spec('/gmail/INBOX'), row('INBOX'))
    expect(listing).toBeInstanceOf(DirListing)
    expect((listing as DirListing).window).toBe(true)
    expect([...(listing as DirListing).seeds.keys()]).toEqual(['2026-04-27'])
  })

  it('lists a day on its own as a window', async () => {
    // The label listing seeds its days, so a day read after it never reaches
    // the day lister; listing the day first is what exercises that lister.
    const listing = await readdir(
      account.gmailAccessor(),
      spec('/gmail/INBOX/2026-04-27'),
      row('2026-04-27'),
    )
    expect(listing).toBeInstanceOf(DirListing)
    expect((listing as DirListing).window).toBe(true)
    expect((listing as DirListing).entries.map((one) => one.name)).toEqual([
      `Hi_27__${x1}.gmail.json`,
    ])
  })
})
