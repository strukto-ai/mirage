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
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { AirtableVFS } from '../../vfs/airtable/airtable.ts'
import type { AirtableConfig } from './config.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { FakeAirtable, makeAccessor } from '../../../tests/core/airtable/_test_util.ts'
import { read, readStream } from './read.ts'

const ROOT = '/at'
const BASE = `${ROOT}/bases/Product_Roadmap__appRoadmapBase001`
const TABLE = `${BASE}/Features__tblFeatures000001`
const RECORDS = `${TABLE}/records.jsonl`
const DONE = `${TABLE}/views/Done_shipped__viwDone0000000001.jsonl`
const DEC = new TextDecoder()

// The rows the mount hands a read: the file's, as its folder's listing names
// it, and its folder's.
const ROW = new FileStat({ name: 'file', type: FileType.FILE })
const DIR = new FileStat({ name: 'dir', type: FileType.DIRECTORY })

async function mounted(
  fake: FakeAirtable,
  overrides: Partial<AirtableConfig> = {},
): Promise<Workspace> {
  const vfs = Object.assign(new AirtableVFS({ token: 'pat' }), {
    accessor: makeAccessor(fake, overrides),
  })
  return new Workspace({ [`${ROOT}/`]: vfs }, { shellParser: await getTestParser() })
}

function spec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')),
    vfsPath: mountKey(virtual, ROOT),
  })
}

function ids(body: Uint8Array): string[] {
  return DEC.decode(body)
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => (JSON.parse(l) as { record_id: string }).record_id)
}

describe('airtable read', () => {
  it('renders every record across pages', async () => {
    const body = await read(makeAccessor(new FakeAirtable()), spec(RECORDS), ROW, DIR)
    expect(ids(body)).toHaveLength(7)
    expect(JSON.parse(DEC.decode(body).split('\n')[0] ?? '')).toEqual({
      record_id: 'rec00000000000001',
      created_time: '2026-01-01T09:00:00.000Z',
      fields: { Name: 'Feature 1', Priority: 1, Status: 'Done' },
    })
  })

  it('fetches only as many records as a limit asks for', async () => {
    const fake = new FakeAirtable()
    const body = await read(makeAccessor(fake), spec(RECORDS), ROW, DIR, {
      limit: 2,
    })
    expect(ids(body)).toEqual(['rec00000000000001', 'rec00000000000002'])
    const calls = fake.recordCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.maxRecords).toBe('2')
  })

  it('applies the view of a view file', async () => {
    const fake = new FakeAirtable()
    const body = await read(makeAccessor(fake), spec(DONE), ROW, DIR)
    expect(ids(body)).toHaveLength(4)
    expect(fake.recordCalls()[0]?.view).toBe('viwDone0000000001')
  })

  it('refuses a full read past the cap', async () => {
    const fake = new FakeAirtable()
    const accessor = makeAccessor(fake, { maxReadRecords: 5 })
    await expect(read(accessor, spec(RECORDS), ROW, DIR)).rejects.toMatchObject({
      code: 'EFBIG',
    })
    // the refusal needed cap + 1 records, not the whole table
    expect(fake.recordCalls().at(-1)?.maxRecords).toBe('6')
    const body = await read(accessor, spec(RECORDS), ROW, DIR, { limit: 3 })
    expect(ids(body)).toHaveLength(3)
  })

  it('reads a window past the cap on a small view', async () => {
    const body = await read(
      makeAccessor(new FakeAirtable(), { maxReadRecords: 5 }),
      spec(DONE),
      ROW,
      DIR,
      { limit: 50 },
    )
    expect(ids(body)).toHaveLength(4)
  })

  it('skips records for an offset', async () => {
    const body = await read(makeAccessor(new FakeAirtable()), spec(RECORDS), ROW, DIR, {
      limit: 2,
      offset: 3,
    })
    expect(ids(body)).toEqual(['rec00000000000004', 'rec00000000000005'])
  })

  it('answers ENOENT for missing tables and views', async () => {
    const ws = await mounted(new FakeAirtable())
    for (const path of [
      `${BASE}/Gone__tblGone0000000001/records.jsonl`,
      `${TABLE}/views/Gone__viwGone0000000001.jsonl`,
      `${BASE}/Gone__tblGone0000000001/table.json`,
    ]) {
      await expect(ws.dispatch('read', path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('answers ENOENT for a base outside baseIds', async () => {
    const fake = new FakeAirtable()
    const ws = await mounted(fake, { baseIds: ['appOpsFinance0001'] })
    for (const path of [RECORDS, `${BASE}/base.json`, `${TABLE}/table.json`]) {
      await expect(ws.dispatch('read', path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(fake.recordCalls()).toEqual([])
  })

  it('answers ENOENT for a name the listing does not hold', async () => {
    const fake = new FakeAirtable()
    const ws = await mounted(fake)
    const ops = `${ROOT}/bases/Ops_Finance__appOpsFinance0001`
    for (const path of [
      `${ROOT}/bases/Wrong__appRoadmapBase001/base.json`,
      `${BASE}/Wrong__tblFeatures000001/table.json`,
      `${BASE}/Wrong__tblFeatures000001/records.jsonl`,
      `${TABLE}/views/Wrong__viwDone0000000001.jsonl`,
      `${ops}/Q3_Budget__tblBudget00000001/views/Grid_view__viwGrid0000000001.jsonl`,
    ]) {
      await expect(ws.dispatch('read', path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    // the ids resolve at the API; only the listing knows the names
    expect(fake.recordCalls()).toEqual([])
  })

  it('proves nothing with no rows handed', async () => {
    const fake = new FakeAirtable()
    const accessor = makeAccessor(fake)
    for (const path of [DONE, RECORDS]) {
      await expect(read(accessor, spec(path))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(fake.recordCalls()).toEqual([])
  })

  it('answers ENOENT for a view gone since its listing', async () => {
    const fake = new FakeAirtable()
    // the schema still lists the view; Airtable answers its id missing
    Reflect.deleteProperty(fake.views, 'viwDone0000000001')
    await expect(read(makeAccessor(fake), spec(DONE), ROW, DIR)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

async function drain(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('airtable read stream', () => {
  it('renders the read a page at a time', async () => {
    const accessor = makeAccessor(new FakeAirtable())
    const chunks = await drain(readStream(accessor, spec(RECORDS), ROW, DIR))
    expect(chunks.map((c) => ids(c).length)).toEqual([3, 3, 1])
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.from(await read(accessor, spec(RECORDS), ROW, DIR)),
    )
  })

  it('stops paging when the reader stops', async () => {
    const fake = new FakeAirtable()
    const stream = readStream(makeAccessor(fake), spec(RECORDS), ROW, DIR)
    const first = await stream.next()
    await stream.return()
    expect(ids(first.value as Uint8Array)).toHaveLength(3)
    expect(fake.recordCalls()).toHaveLength(1)
  })

  it('stops past the cap after that many records', async () => {
    const fake = new FakeAirtable()
    const got: Uint8Array[] = []
    await expect(
      (async () => {
        for await (const chunk of readStream(
          makeAccessor(fake, { maxReadRecords: 5 }),
          spec(RECORDS),
          ROW,
          DIR,
        ))
          got.push(chunk)
      })(),
    ).rejects.toMatchObject({ code: 'EFBIG' })
    expect(ids(Buffer.concat(got))).toHaveLength(5)
    expect(fake.recordCalls().at(-1)?.maxRecords).toBe('6')
  })

  it('applies a view and proves its paths', async () => {
    const accessor = makeAccessor(new FakeAirtable())
    const body = Buffer.concat(await drain(readStream(accessor, spec(DONE), ROW, DIR)))
    expect(ids(body)).toHaveLength(4)
    const ws = await mounted(new FakeAirtable())
    for (const path of [
      `${BASE}/Gone__tblGone0000000001/records.jsonl`,
      `${TABLE}/views/Gone__viwGone0000000001.jsonl`,
    ]) {
      const result = await ws.shell(`cat < ${path}`)
      expect(result.exitCode).toBe(1)
      expect(result.stderrText).toContain('No such file or directory')
    }
  })

  it('reads another file whole', async () => {
    const accessor = makeAccessor(new FakeAirtable())
    const chunks = await drain(readStream(accessor, spec(`${TABLE}/table.json`), ROW, DIR))
    expect(chunks).toEqual([await read(accessor, spec(`${TABLE}/table.json`), ROW, DIR)])
  })
})
