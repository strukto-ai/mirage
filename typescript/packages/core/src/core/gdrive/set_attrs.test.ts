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
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { GoogleApiError } from '../google/client.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { FILE, GoogleAccount } from '../../../tests/core/google/account.ts'
import { setAttrs } from './set_attrs.ts'

const MTIME = '2020-01-01T00:00:00+00:00'

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

function row(fileId: string): FileStat {
  return new FileStat({ name: 'a.txt', type: FileType.FILE, extra: { file_id: fileId } })
}

describe('gdrive setAttrs', () => {
  it("stores an mtime as the file's modified time", async () => {
    const made = await account.upload('a.txt', 'a')
    await account.run.recordRequests()
    expect(
      await setAttrs(
        account.driveAccessor(),
        PathSpec.fromStrPath('/a.txt'),
        { uid: 7, mtime: MTIME },
        row(made),
      ),
    ).toEqual({ uid: 7 })
    expect(await account.run.bodies('PATCH', FILE)).toEqual([
      { modifiedTime: '2020-01-01T00:00:00Z' },
    ])
    expect((await account.item(made)).modifiedTime).toBe('2020-01-01T00:00:00.000Z')
  })

  it('keeps the attributes of the mount root', async () => {
    await account.run.recordRequests()
    expect(
      await setAttrs(account.driveAccessor(), PathSpec.fromStrPath('/'), { uid: 7, mtime: MTIME }),
    ).toEqual({ uid: 7, mtime: MTIME })
    expect(await account.log()).toEqual([])
  })

  it.each<[number, string]>([
    [404, 'ENOENT'],
    [403, 'EACCES'],
  ])('answers a %i from the patch as %s', async (status, code) => {
    const made = await account.upload('a.txt', 'a')
    await account.refuse('PATCH', FILE, status, `File not found: ${made}.`)
    await expect(
      setAttrs(
        account.driveAccessor(),
        PathSpec.fromStrPath('/a.txt'),
        { mtime: MTIME },
        row(made),
      ),
    ).rejects.toMatchObject({ code })
  })

  it('passes any other failed patch through', async () => {
    const made = await account.upload('a.txt', 'a')
    await account.refuse('PATCH', FILE, 500, 'down')
    await expect(
      setAttrs(
        account.driveAccessor(),
        PathSpec.fromStrPath('/a.txt'),
        { mtime: MTIME },
        row(made),
      ),
    ).rejects.toBeInstanceOf(GoogleApiError)
  })
})
