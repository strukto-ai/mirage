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
import type { DirListing } from '../../types.ts'
import { PathSpec, type FileStat } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { AirtableVFS } from '../../vfs/airtable/airtable.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { AirtableAccount } from '../../../tests/fixtures/airtable_account.ts'
import type { AirtableConfig } from './config.ts'
import { readdir } from './readdir.ts'

let origin = ''
let account: AirtableAccount

beforeAll(async () => {
  origin = await serve('airtable')
})

beforeEach(async () => {
  account = new AirtableAccount(origin)
  await account.reset()
  await account.run.recordRequests()
})

afterEach(async () => {
  await account.run.close()
})

const ROOT = '/at'
const BASE = `${ROOT}/bases/Product_Roadmap__appRoadmapBase001`
const TABLE = `${BASE}/Features__tblFeatures000001`

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, ROOT) })
}

function names(listed: readonly FileStat[] | DirListing): string[] {
  return rowsOf(listed).map((row) => row.name)
}

function mounted(overrides: Partial<AirtableConfig> = {}): Workspace {
  const vfs = Object.assign(new AirtableVFS({ token: 'pat' }), {
    accessor: account.accessor(overrides),
  })
  return new Workspace({ [`${ROOT}/`]: vfs })
}

describe('airtable readdir', () => {
  it('roots at the bases directory', async () => {
    const out = await readdir(account.accessor(), spec(`${ROOT}/`))
    expect(names(out)).toEqual(['bases'])
  })

  it('lists bases as named directories', async () => {
    const out = await readdir(account.accessor(), spec(`${ROOT}/bases`))
    expect(names(out)).toEqual([
      'Product_Roadmap__appRoadmapBase001',
      'Ops_Finance__appOpsFinance0001',
    ])
  })

  it('lists base.json and the tables of a base', async () => {
    const accessor = account.accessor()
    const [base] = rowsOf(await readdir(accessor, spec(`${ROOT}/bases`)))
    const out = await readdir(accessor, spec(BASE), base ?? null)
    expect(names(out)).toEqual(['base.json', 'Features__tblFeatures000001'])
  })

  it('seeds every table and views dir from one schema call', async () => {
    const ws = mounted()
    await ws.dispatch('readdir', BASE)
    const before = (await account.asked()).length
    const table = await ws.dispatch('readdir', TABLE)
    const views = await ws.dispatch('readdir', `${TABLE}/views`)
    expect(await account.asked()).toHaveLength(before)
    expect(table).toEqual([`${TABLE}/table.json`, `${TABLE}/records.jsonl`, `${TABLE}/views`])
    expect(views).toEqual([
      `${TABLE}/views/Grid_view__viwGrid0000000001.jsonl`,
      `${TABLE}/views/Done_shipped__viwDone0000000001.jsonl`,
    ])
  })

  it('warms a cold table listing through its base', async () => {
    const out = (await mounted().dispatch('readdir', TABLE)) as string[]
    expect(out).toContain(`${TABLE}/records.jsonl`)
  })

  it('answers ENOENT for an unknown or out-of-scope base', async () => {
    await expect(
      mounted().dispatch('readdir', `${ROOT}/bases/X__appNope000000001`),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      mounted({ baseIds: ['appOpsFinance0001'] }).dispatch('readdir', BASE),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
