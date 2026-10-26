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

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DONE,
  DONE_FORMULA,
  FEATURES,
  FakeAirtable,
  MODEL_NOT_FOUND,
  OPS,
  ROADMAP,
  TOKEN,
} from '../../../../../tests/core/airtable/_test_util.ts'
import { MountMode } from '../../../../types.ts'
import { AirtableVFS } from '../../../../vfs/airtable/airtable.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { AIRTABLE } from './index.ts'

// Mirrors python/tests/commands/cli/builtin/airtable/test_reads.py.

const DEC = new TextDecoder()
const BASE_DIR = '/at/bases/Product_Roadmap__appRoadmapBase001'
const TABLE_DIR = `${BASE_DIR}/Features__tblFeatures000001`
const AT = `--base ${ROADMAP} --table ${FEATURES}`
const FIRST = 'rec00000000000001'

type Shell = (line: string) => Promise<[number, string, string]>

const opened: Workspace[] = []

function open(fake: FakeAirtable, overrides: Record<string, unknown> = {}): Shell {
  vi.stubGlobal('fetch', fake.fetch)
  const config = { token: TOKEN, requestsPerSecond: 10_000, ...overrides }
  const mount = new AirtableVFS(config, { fetchFn: fake.fetch })
  const ws = new Workspace(
    { '/at/': [mount, MountMode.READ], '/s/': new RAMVFS() },
    { mode: MountMode.WRITE },
  )
  ws.registerCli('airtable', AIRTABLE, config)
  opened.push(ws)
  return async (line) => {
    const io = await ws.shell(line)
    return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
  }
}

function usage(message: string): [number, string, string] {
  return [2, '', `${message}\n`]
}

describe('airtable read verbs', () => {
  afterEach(async () => {
    for (const ws of opened.splice(0)) await ws.close()
    vi.unstubAllGlobals()
  })

  it('scopes base list by baseIds', async () => {
    const run = open(new FakeAirtable(), { baseIds: [OPS] })
    const [code, out] = await run('airtable base list')
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual([
      { base_id: OPS, base_name: 'Ops / Finance ✓', permission_level: 'read' },
    ])
  })

  it("prints the mount's own base.json and table.json", async () => {
    const run = open(new FakeAirtable())
    expect((await run(`airtable base get ${ROADMAP}`))[1]).toBe(
      (await run(`cat ${BASE_DIR}/base.json`))[1],
    )
    for (const ref of [FEATURES, 'Features']) {
      expect((await run(`airtable table get --base ${ROADMAP} ${ref}`))[1]).toBe(
        (await run(`cat ${TABLE_DIR}/table.json`))[1],
      )
    }
  })

  it('refuses an unknown base or table', async () => {
    const run = open(new FakeAirtable())
    expect(await run('airtable base get appNope0000000001')).toEqual([
      1,
      '',
      'airtable base get: appNope0000000001: no such base\n',
    ])
    expect(await run(`airtable table get --base ${ROADMAP} Nope`)).toEqual([
      1,
      '',
      `airtable table get: Nope: no such table in ${ROADMAP}\n`,
    ])
  })

  it('prints records.jsonl lines', async () => {
    const run = open(new FakeAirtable())
    const [, listed] = await run(`airtable record list ${AT}`)
    expect(listed).toBe((await run(`cat ${TABLE_DIR}/records.jsonl`))[1])
    expect(listed.split('\n').filter((l) => l !== '')).toHaveLength(7)
  })

  it('refuses past the read cap rather than paging', async () => {
    const fake = new FakeAirtable()
    const run = open(fake, { maxReadRecords: 5 })
    expect(await run(`airtable record list ${AT}`)).toEqual([
      1,
      '',
      'airtable record list: more than 5 records match (max_read_records); narrow them with ' +
        '--formula or --view, or take the first N with --max-records N\n',
    ])
    expect(fake.recordCalls().map((c) => c.maxRecords)).toEqual(['6', '6'])
  })

  it('honors --max-records as asked', async () => {
    const fake = new FakeAirtable()
    const run = open(fake, { maxReadRecords: 5 })
    const [code, out] = await run(`airtable record list ${AT} --max-records 7`)
    expect(code).toBe(0)
    expect(out.split('\n').filter((l) => l !== '')).toHaveLength(7)
    expect(fake.recordCalls()[0]?.maxRecords).toBe('7')
    expect(await run(`airtable record list ${AT} --max-records 0`)).toEqual(
      usage('--max-records must be at least 1'),
    )
  })

  it('passes the formula and the view through', async () => {
    const fake = new FakeAirtable()
    const run = open(fake)
    expect(
      await run(
        `airtable record list ${AT} --view ${DONE} --formula "${DONE_FORMULA}" | jq -r .fields.Priority`,
      ),
    ).toEqual([0, '1\n3\n5\n7\n', ''])
    const call = fake.recordCalls()[0]
    expect([call?.view, call?.filterByFormula]).toEqual([DONE, DONE_FORMULA])
  })

  it('prints one line for record get', async () => {
    const run = open(new FakeAirtable())
    const [code, out] = await run(`airtable record get ${AT} ${FIRST}`)
    expect(code).toBe(0)
    expect(out.split('\n')).toHaveLength(2)
    expect((JSON.parse(out) as { record_id: string }).record_id).toBe(FIRST)
    expect(await run(`airtable record get ${AT} recZZZZZZZZZZZZZZ`)).toEqual([
      1,
      '',
      `airtable record get: Airtable API error (GET /${ROADMAP}/${FEATURES}/recZZZZZZZZZZZZZZ): ` +
        `HTTP 403: INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND: ${MODEL_NOT_FOUND}\n`,
    ])
  })

  it('normalizes comments in api order', async () => {
    const run = open(new FakeAirtable())
    const [code, out] = await run(`airtable comment list ${AT} ${FIRST}`)
    expect(code).toBe(0)
    const comments = JSON.parse(out) as Record<string, unknown>[]
    expect(comments.map((c) => c.text)).toEqual(['Shipped it.', 'Looks good.'])
    expect(Object.keys(comments[0] ?? {})).toEqual([
      'comment_id',
      'author_id',
      'author_email',
      'author_name',
      'text',
      'created_time',
      'last_updated_time',
    ])
  })

  it.each([
    `airtable base get ${OPS}`,
    `airtable table get --base ${OPS} tblBudget00000001`,
    `airtable record list --base ${OPS} --table tblBudget00000001`,
    `airtable record get --base ${OPS} --table tblBudget00000001 ${FIRST}`,
    `airtable comment list --base ${OPS} --table tblBudget00000001 ${FIRST}`,
  ])('refuses a base outside the scope unsent: %s', async (line) => {
    const fake = new FakeAirtable()
    const run = open(fake, { baseIds: [ROADMAP] })
    const verb = line.split(' ').slice(0, 3).join(' ')
    expect(await run(line)).toEqual([1, '', `${verb}: ${OPS}: Permission denied\n`])
    expect(fake.calls).toEqual([])
  })

  it.each([
    ['airtable base list extra', 'unrecognized arguments: extra'],
    ['airtable base get', 'the following arguments are required: BASE'],
    [`airtable base get ${ROADMAP} ${OPS}`, `unrecognized arguments: ${OPS}`],
    [`airtable table get --base ${ROADMAP}`, 'the following arguments are required: TABLE'],
    [`airtable record get ${AT}`, 'the following arguments are required: RECORD'],
    [`airtable comment list ${AT} a b`, 'unrecognized arguments: b'],
  ])('refuses operands as usage errors: %s', async (line, message) => {
    const fake = new FakeAirtable()
    const run = open(fake)
    expect(await run(line)).toEqual(usage(message))
    expect(fake.calls).toEqual([])
  })
})
