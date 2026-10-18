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

import { describe, expect, it, vi } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { FakeAirtable, ROADMAP, makeAccessor } from '../../../tests/core/airtable/_test_util.ts'
import { linesContaining } from './search.ts'

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

function statusHolds(query: string) {
  return (row: Record<string, unknown>) => {
    const status = (row.fields as Record<string, unknown>).Status
    return typeof status === 'string' && status.toLowerCase().includes(query)
  }
}

// Twin of python/tests/core/airtable/test_search.py.
describe('airtable linesContaining', () => {
  it('lists only the records a formula names', async () => {
    const fake = new FakeAirtable()
    fake.formulas[formula('one')] = statusHolds('one')
    const out = await linesContaining(makeAccessor(fake), spec(RECORDS), 'one', ROW)
    expect(ids(out)).toEqual(DONE_IDS)
    const call = fake.recordCalls().at(-1)
    expect(call?.filterByFormula).toBe(formula('one'))
    expect(call?.maxRecords).toBe('10001')
  })

  it('lists what the view and the formula name for a view file', async () => {
    const fake = new FakeAirtable()
    fake.formulas[formula('ure')] = () => true
    const out = await linesContaining(makeAccessor(fake), spec(DONE), 'ure', ROW)
    expect(ids(out)).toEqual(DONE_IDS)
    expect(fake.recordCalls().at(-1)?.view).toBe('viwDone0000000001')
  })

  // A link, an AI text or an attachment holds no space outside the text a
  // formula reads of it: a text with a space leaves a link out and asks the
  // others, and a single word reads the file.
  it('asks a text with a space of a table with links', async () => {
    const fake = new FakeAirtable()
    const fields = (fake.tables[ROADMAP]?.[0]?.fields ?? []) as Record<string, unknown>[]
    fields.push(
      { id: 'fldRelease000001', name: 'Release', type: 'multipleRecordLinks' },
      { id: 'fldSummary000001', name: 'Summary', type: 'aiText' },
    )
    fake.formulas[formula('lone plan', [...CELLS, '{Summary} & ""'])] = () => false
    const accessor = makeAccessor(fake)
    const out = await linesContaining(accessor, spec(RECORDS), 'lone plan', ROW)
    expect(out).toEqual(new Uint8Array())
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
    ['zzz', RECORDS],
  ])('reads the file for %j at %s', async (text, virtual) => {
    const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      // A view no listing names is handed no row.
      const row = virtual.includes('Nope') ? null : ROW
      const out = await linesContaining(makeAccessor(new FakeAirtable()), spec(virtual), text, row)
      expect(out).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  // A listing that fails to connect leaves the file to a read.
  it('reads the file when the listing fails to connect', async () => {
    const fake = new FakeAirtable()
    fake.formulas[formula('one')] = statusHolds('one')
    const real = fake.fetch
    vi.spyOn(fake, 'fetch').mockImplementation((input, init) =>
      typeof input === 'string' && input.includes('filterByFormula')
        ? Promise.reject(new TypeError('fetch failed'))
        : real(input, init),
    )
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const out = await linesContaining(makeAccessor(fake), spec(RECORDS), 'one', ROW)
      expect(out).toBeNull()
    } finally {
      debug.mockRestore()
    }
  })

  it('reads the file when more records match than the cap', async () => {
    const fake = new FakeAirtable()
    fake.formulas[formula('one')] = statusHolds('one')
    const out = await linesContaining(
      makeAccessor(fake, { maxReadRecords: 2 }),
      spec(RECORDS),
      'one',
      ROW,
    )
    expect(out).toBeNull()
  })
})
