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
import { FakeAirtable, TOKEN } from '../../core/airtable/_test_util.ts'
import { VFSName } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { AirtableVFS } from './airtable.ts'

const TABLE = '/at/bases/Product_Roadmap__appRoadmapBase001/Features__tblFeatures000001'
const DEC = new TextDecoder()

function vfs(fake: FakeAirtable, overrides: { maxReadRecords?: number } = {}): AirtableVFS {
  return new AirtableVFS(
    { token: TOKEN, requestsPerSecond: 10_000, ...overrides },
    {
      fetchFn: fake.fetch,
    },
  )
}

describe('AirtableVFS', () => {
  it('never serves reads from the file cache', () => {
    const mount = vfs(new FakeAirtable())
    expect(mount.kind).toBe(VFSName.AIRTABLE)
    expect(mount.cachesReads).toBe(false)
    expect(mount.sizesAlwaysKnown).toBe(false)
    expect(mount.supportsSnapshot).toBe(false)
  })

  it('exposes a read-only file surface', () => {
    const names = new Set(
      vfs(new FakeAirtable())
        .commands()
        .map((c) => c.name),
    )
    for (const name of ['cat', 'ls', 'find', 'grep', 'head', 'jq', 'wc']) {
      expect(names.has(name)).toBe(true)
    }
    expect(
      vfs(new FakeAirtable())
        .ops()
        .filter((op) => op.write),
    ).toEqual([])
  })

  it('redacts the token from its state', () => {
    const state = vfs(new FakeAirtable()).getState()
    expect(state.type).toBe('airtable')
    expect(JSON.stringify(state)).not.toContain(TOKEN)
  })

  it('browses bases, tables and records through a workspace', async () => {
    const ws = new Workspace(
      { '/at/': vfs(new FakeAirtable(), { maxReadRecords: 5 }) },
      { shellParser: await getTestParser() },
    )
    try {
      const tree = await ws.shell('tree /at/bases/Product_Roadmap__appRoadmapBase001')
      expect(DEC.decode(tree.stdout)).toContain('records.jsonl')
      const names = await ws.shell(`head -n 3 ${TABLE}/records.jsonl | jq -r .fields.Name`)
      expect(DEC.decode(names.stdout).split('\n').slice(0, 3)).toEqual([
        'Feature 1',
        'Feature 2',
        'Feature 3',
      ])
      const done = await ws.shell(`wc -l < ${TABLE}/views/Done_shipped__viwDone0000000001.jsonl`)
      expect(DEC.decode(done.stdout).trim()).toBe('4')
      const refused = await ws.shell(`cat ${TABLE}/records.jsonl`)
      expect(refused.exitCode).toBe(1)
      expect(DEC.decode(refused.stderr)).toBe(`cat: ${TABLE}/records.jsonl: File too large\n`)
    } finally {
      await ws.close()
    }
  })
})
