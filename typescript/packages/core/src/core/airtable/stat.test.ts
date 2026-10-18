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

import { describe, expect, it } from 'vitest'
import { ContentType, FileType, type FileStat } from '../../types.ts'
import { AirtableVFS } from '../../vfs/airtable/airtable.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { FakeAirtable, makeAccessor } from '../../../tests/core/airtable/_test_util.ts'

const ROOT = '/at'
const BASE = `${ROOT}/bases/Product_Roadmap__appRoadmapBase001`
const TABLE = `${BASE}/Features__tblFeatures000001`

function mounted(): Workspace {
  const vfs = Object.assign(new AirtableVFS({ token: 'pat' }), {
    accessor: makeAccessor(new FakeAirtable()),
  })
  return new Workspace({ [`${ROOT}/`]: vfs })
}

async function statAt(ws: Workspace, path: string): Promise<FileStat> {
  return (await ws.dispatch('stat', path)) as FileStat
}

describe('airtable stat', () => {
  it('sizes json leaves at their rendered byte length', async () => {
    const ws = mounted()
    for (const leaf of [`${BASE}/base.json`, `${TABLE}/table.json`]) {
      const info = await statAt(ws, leaf)
      const body = (await ws.dispatch('read', leaf)) as Uint8Array
      expect(info.type).toBe(FileType.FILE)
      expect(info.content).toBe(ContentType.JSON)
      expect(info.size).toBe(body.byteLength)
    }
  })

  it('leaves record files size-unknown', async () => {
    const ws = mounted()
    const records = await statAt(ws, `${TABLE}/records.jsonl`)
    const view = await statAt(ws, `${TABLE}/views/Done_shipped__viwDone0000000001.jsonl`)
    expect(records.size).toBeNull()
    expect(view.size).toBeNull()
    expect(view.extra).toEqual({ view_id: 'viwDone0000000001' })
  })

  it('stats directories as directories', async () => {
    const ws = mounted()
    for (const path of [`${ROOT}/bases`, BASE, TABLE, `${TABLE}/views`]) {
      expect((await statAt(ws, path)).type).toBe(FileType.DIRECTORY)
    }
  })

  it('answers ENOENT for an unlisted view', async () => {
    await expect(
      statAt(mounted(), `${TABLE}/views/Gone__viwGone0000000001.jsonl`),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
