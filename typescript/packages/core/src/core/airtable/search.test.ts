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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import {
  AirtableAccount,
  FEATURES,
  RECORDS as RECORDS_ROUTE,
} from '../../../tests/fixtures/airtable_account.ts'
import { linesContaining } from './search.ts'

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
const TABLE = `${ROOT}/bases/Product_Roadmap__appRoadmapBase001/Features__tblFeatures000001`
const RECORDS = `${TABLE}/records.jsonl`
const DONE = `${TABLE}/views/Done_shipped__viwDone0000000001.jsonl`
const CELLS = ['RECORD_ID()', '{Name} & ""', '{Status} & ""']
const DONE_IDS = [1, 3, 5, 7].map((n) => `rec${String(n).padStart(14, '0')}`)
const DEC = new TextDecoder()

// The file's row as its folder's listing names it, which the mount hands.
const ROW = new FileStat({ name: 'file', type: FileType.FILE })

function spec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')),
    vfsPath: mountKey(virtual, ROOT),
  })
}

function formula(query: string, cells: readonly string[] = CELLS): string {
  return `OR(${cells.map((cell) => `SEARCH("${query}", LOWER(${cell}))`).join(', ')})`
}

function ids(body: Uint8Array | null): string[] {
  expect(body).not.toBeNull()
  return DEC.decode(body ?? new Uint8Array())
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => (JSON.parse(l) as { record_id: string }).record_id)
}

// Twin of python/tests/core/airtable/test_search.py.
describe('airtable linesContaining', () => {
  // The fake evaluates the formula: only Status, Done on the odd records,
  // holds "one".
  it('lists only the records a formula names', async () => {
    const out = await linesContaining(account.accessor(), spec(RECORDS), 'one', ROW)
    expect(ids(out)).toEqual(DONE_IDS)
    const call = (await account.recordQueries()).at(-1)
    expect(call?.filterByFormula).toBe(formula('one'))
    expect(call?.maxRecords).toBe('10001')
  })

  // Every name holds "ure" (Feature n), so the view decides.
  it('lists what the view and the formula name for a view file', async () => {
    const out = await linesContaining(account.accessor(), spec(DONE), 'ure', ROW)
    expect(ids(out)).toEqual(DONE_IDS)
    expect((await account.recordQueries()).at(-1)?.view).toBe('viwDone0000000001')
  })

  // A link, an AI text or an attachment holds no space outside the text a
  // formula reads of it: a text with a space leaves a link out and asks the
  // others, and a single word reads the file.
  it('asks a text with a space of a table with links', async () => {
    // Fields no record here fills, added to the schema as a base admin
    // would; no request of this API adds one.
    for (const [seq, field, name, kind] of [
      [10, 'fldRelease0000001', 'Release', 'multipleRecordLinks'],
      [11, 'fldSummary0000001', 'Summary', 'aiText'],
    ] as const) {
      await account.run.execute(
        "INSERT INTO AirtableField (tenant, id, tableId, name, type, seq) VALUES ('default', ?, ?, ?, ?, ?)",
        field,
        FEATURES,
        name,
        kind,
        seq,
      )
    }
    await account.run.recordRequests()
    const accessor = account.accessor()
    const out = await linesContaining(accessor, spec(RECORDS), 'lone plan', ROW)
    expect(out).toEqual(new Uint8Array())
    expect((await account.recordQueries()).at(-1)?.filterByFormula).toBe(
      formula('lone plan', [...CELLS, '{Summary} & ""']),
    )
    expect(await linesContaining(accessor, spec(RECORDS), 'one', ROW)).toBeNull()
  })

  it.each([
    ['name', RECORDS],
    ['atus', RECORDS],
    ['true', RECORDS],
    ['q4', RECORDS],
    ['add', RECORDS],
    ['one', `${TABLE}/table.json`],
    ['one', `${TABLE}/views/Nope__viwNope000000000001.jsonl`],
  ])('reads the file for %j at %s', async (text, virtual) => {
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      // A view no listing names is handed no row.
      const row = virtual.includes('Nope') ? null : ROW
      const out = await linesContaining(account.accessor(), spec(virtual), text, row)
      expect(out).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  // A formula Airtable refuses proves nothing, so the file is read; one it
  // answers with no record is the answer, and no line holds the text.
  it('reads the file when Airtable refuses the formula', async () => {
    await account.run.answerNext('GET', RECORDS_ROUTE, 422, {
      error: {
        type: 'INVALID_FILTER_BY_FORMULA',
        message: 'The formula for filtering records is invalid',
      },
    })
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      expect(await linesContaining(account.accessor(), spec(RECORDS), 'zzz', ROW)).toBeNull()
    } finally {
      debug.mockRestore()
    }
  })

  it('lists nothing for a text no record holds', async () => {
    const out = await linesContaining(account.accessor(), spec(RECORDS), 'zzz', ROW)
    expect(out).toEqual(new Uint8Array())
  })

  // A listing that fails to connect leaves the file to a read: every
  // attempt finds its connection closed.
  it('reads the file when the listing fails to connect', async () => {
    await account.run.answerNext('GET', RECORDS_ROUTE, null, undefined, 50)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const out = await linesContaining(account.accessor(), spec(RECORDS), 'one', ROW)
      expect(out).toBeNull()
    } finally {
      debug.mockRestore()
    }
  })

  it('reads the file when more records match than the cap', async () => {
    const out = await linesContaining(
      account.accessor({ maxReadRecords: 2 }),
      spec(RECORDS),
      'one',
      ROW,
    )
    expect(out).toBeNull()
  })
})
