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
import { PathSpec } from '../../types.ts'
import { DropboxAccount } from '../../../tests/core/dropbox/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { DropboxApiError } from './client.ts'
import { rename } from './rename.ts'

let origin: string
let account: DropboxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('dropbox')
}, 30_000)

beforeEach(() => {
  account = new DropboxAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

describe('dropbox rename conflict probe', () => {
  it('is bounded to one entry', async () => {
    // The probe is bounded, not a full listing: listFolder follows every
    // continuation cursor, so asking it with a small page size made one
    // request per child to answer a yes/no.
    await account.mkdir('/src')
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await account.put(`/dst/${name}`, new Uint8Array([107]))
    }
    await account.run.recordRequests()
    await expect(
      rename(account.accessor(), PathSpec.fromStrPath('/src'), PathSpec.fromStrPath('/dst')),
    ).rejects.toBeInstanceOf(DropboxApiError)
    const listed = await account.run.bodies('POST', '/2/files/list_folder')
    expect(listed.map((body) => (body as { limit?: number }).limit)).toEqual([1])
    expect(await account.run.bodies('POST', '/2/files/list_folder/continue')).toEqual([])
    expect(await account.run.bodies('POST', '/2/files/delete_v2')).toEqual([])
  })
})
