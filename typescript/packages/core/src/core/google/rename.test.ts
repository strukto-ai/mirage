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
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { rename } from '../gdocs/rename.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { FILE, GoogleAccount } from '../../../tests/core/google/account.ts'
import { appTitle } from './rename.ts'

const MIME = 'application/vnd.google-apps.document'
const MODIFIED = '2026-10-01T09:00:00.000Z'
const NEW = '2026-10-01_New_Plan__doc1.gdoc.json'

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
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, '/gdocs') })
}

async function plan(): Promise<string> {
  const made = await account.create('Old Plan', MIME)
  await account.patch(made, { modifiedTime: MODIFIED })
  await account.run.recordRequests()
  return made
}

async function renamed(made: string, dst: string): Promise<void> {
  const old = `2026-10-01_Old_Plan__${made}.gdoc.json`
  const entry = new FileStat({
    name: old,
    type: FileType.FILE,
    modified: MODIFIED,
    extra: { doc_id: made, doc_name: 'Old Plan' },
  })
  await rename(
    new GDocsAccessor({ tokenManager: account.tokenManager() }),
    spec(`/gdocs/owned/${old}`),
    spec(dst),
    entry,
  )
}

describe('appTitle', () => {
  it.each<[string, string | null]>([
    [NEW, 'New_Plan'],
    ['2026-09-30_New__doc1.gdoc.json', null],
    ['2026-10-01_New__doc2.gdoc.json', null],
    ['2026-10-01_New Plan__doc1.gdoc.json', null],
  ])('gives %s the title %s', (name, title) => {
    expect(appTitle(name, 'doc1', MODIFIED, '.gdoc.json')).toBe(title)
  })
})

describe('google app rename', () => {
  it('sets the title and keeps the modified time', async () => {
    const made = await plan()
    await renamed(made, `/gdocs/owned/2026-10-01_New_Plan__${made}.gdoc.json`)
    expect(await account.run.bodies('PATCH', FILE)).toEqual([
      { name: 'New_Plan', modifiedTime: MODIFIED },
    ])
    const item = await account.item(made)
    expect([item.name, item.modifiedTime]).toEqual(['New_Plan', MODIFIED])
  })

  it.each(['owned/New_Plan.gdoc.json', 'shared'])('refuses %s with EPERM', async (dst) => {
    const made = await plan()
    const target = dst === 'shared' ? `shared/2026-10-01_New_Plan__${made}.gdoc.json` : dst
    await expect(renamed(made, `/gdocs/${target}`)).rejects.toMatchObject({ code: 'EPERM' })
    expect(await account.run.bodies('PATCH', FILE)).toEqual([])
  })
})
