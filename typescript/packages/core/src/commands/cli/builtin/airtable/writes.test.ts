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
  FEATURES,
  FakeAirtable,
  OPS,
  ROADMAP,
  TOKEN,
} from '../../../../../tests/core/airtable/_test_util.ts'
import { MountMode } from '../../../../types.ts'
import { AirtableVFS } from '../../../../vfs/airtable/airtable.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { AIRTABLE } from './index.ts'

// Mirrors python/tests/commands/cli/builtin/airtable/test_writes.py.

type Row = Record<string, unknown>
type Shell = (line: string) => Promise<[number, string, string]>

const DEC = new TextDecoder()
const TABLE_DIR = '/at/bases/Product_Roadmap__appRoadmapBase001/Features__tblFeatures000001'
const AT = `--base ${ROADMAP} --table ${FEATURES}`
const FIRST = 'rec00000000000001'

const opened: Workspace[] = []

function open(fake: FakeAirtable, overrides: Row = {}): Shell {
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

async function lines(run: Shell, path: string, rows: Row[]): Promise<void> {
  const body = rows.map((row) => `${JSON.stringify(row)}\n`).join('')
  await run(`printf '%s' '${body}' > ${path}`)
}

function named(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ fields: { Name: `New ${String(i + 1)}` } }))
}

function usage(message: string): [number, string, string] {
  return [2, '', `${message}\n`]
}

function bodies(fake: FakeAirtable): Row[] {
  return fake.writeCalls().map((c) => c.body as Row)
}

describe('airtable write verbs', () => {
  afterEach(async () => {
    for (const ws of opened.splice(0)) await ws.close()
    vi.unstubAllGlobals()
  })

  it('creates ten records to a request', async () => {
    const fake = new FakeAirtable()
    const run = open(fake)
    await lines(run, '/s/new.jsonl', named(23))
    const [code, out, err] = await run(`airtable record create ${AT} < /s/new.jsonl`)
    expect([code, err]).toEqual([0, ''])
    const created = out
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Row)
    expect((created.at(-1)?.fields as Row).Name).toBe('New 23')
    expect(Object.keys(created[0] ?? {})).toEqual(['record_id', 'created_time', 'fields'])
    expect(bodies(fake).map((b) => (b.records as unknown[]).length)).toEqual([10, 10, 3])
    expect(bodies(fake).every((b) => !('typecast' in b))).toBe(true)
  })

  it('creates one record, typecast as a body key', async () => {
    const fake = new FakeAirtable()
    const run = open(fake)
    const [code, out] = await run(
      `airtable record create ${AT} --typecast --fields '{"Name": "x", "Priority": "4"}'`,
    )
    expect(code).toBe(0)
    expect((JSON.parse(out) as Row).fields).toEqual({ Name: 'x', Priority: '4' })
    expect(bodies(fake)[0]).toEqual({
      records: [{ fields: { Name: 'x', Priority: '4' } }],
      typecast: true,
    })
  })

  it('round-trips a mount line through update', async () => {
    const fake = new FakeAirtable()
    const run = open(fake)
    const [code, out] = await run(
      `jq -c 'select(.fields.Status == "Done") | .fields.Priority = 9' ${TABLE_DIR}/records.jsonl | ` +
        `airtable record update ${AT} | jq -c '[.record_id, .fields.Priority]'`,
    )
    expect(code).toBe(0)
    expect(out.split('\n')[0]).toBe('["rec00000000000001",9]')
    expect(fake.writeCalls().map((c) => c.kind)).toEqual(['update'])
    const [, after] = await run(
      `jq -r 'select(.fields.Priority == 9) | .record_id' ${TABLE_DIR}/records.jsonl`,
    )
    expect(after.split('\n').filter((l) => l !== '')).toEqual([
      'rec00000000000001',
      'rec00000000000003',
      'rec00000000000005',
      'rec00000000000007',
    ])
  })

  it('drops computed fields from a stdin line only', async () => {
    const fake = new FakeAirtable()
    ;(fake.tables[ROADMAP]?.[0]?.fields as Row[]).push({
      id: 'fldTicket0000001',
      name: 'Ticket',
      type: 'formula',
    })
    const run = open(fake)
    await lines(run, '/s/one.jsonl', [
      {
        record_id: FIRST,
        created_time: '2026-01-01T09:00:00.000Z',
        fields: { Name: 'Renamed', Ticket: 'FT-1' },
      },
    ])
    expect((await run(`airtable record update ${AT} < /s/one.jsonl`))[0]).toBe(0)
    expect(bodies(fake)[0]?.records).toEqual([{ id: FIRST, fields: { Name: 'Renamed' } }])
    await run(`airtable record update ${AT} ${FIRST} --fields '{"Ticket": "FT-9"}'`)
    expect((bodies(fake)[1]?.records as Row[])[0]?.fields).toEqual({ Ticket: 'FT-9' })
  })

  it('patches one record', async () => {
    const fake = new FakeAirtable()
    const run = open(fake)
    const [code, out] = await run(
      `airtable record update ${AT} ${FIRST} --fields '{"Priority": 0}'`,
    )
    expect(code).toBe(0)
    expect((JSON.parse(out) as Row).fields).toMatchObject({ Name: 'Feature 1', Priority: 0 })
    expect(fake.writeCalls()[0]?.kind).toBe('update')
  })

  it('deletes by operands or by stdin lines', async () => {
    const fake = new FakeAirtable()
    const run = open(fake)
    expect(await run(`airtable record delete ${AT} ${FIRST}`)).toEqual([
      0,
      '{"record_id":"rec00000000000001","deleted":true}\n',
      '',
    ])
    await run(`cat ${TABLE_DIR}/records.jsonl > /s/all.jsonl`)
    const [code, out] = await run(`airtable record delete ${AT} < /s/all.jsonl`)
    expect([code, out.split('\n').filter((l) => l !== '').length]).toEqual([0, 6])
    expect(fake.records[FEATURES]).toEqual([])
  })

  it('deletes ten records to a request', async () => {
    const fake = new FakeAirtable()
    const run = open(fake)
    await lines(run, '/s/new.jsonl', named(5))
    await run(`airtable record create ${AT} < /s/new.jsonl`)
    const ids = (fake.records[FEATURES] ?? []).map((r) => String(r.id)).join(' ')
    const [code, out] = await run(`airtable record delete ${AT} ${ids}`)
    expect([code, out.split('\n').filter((l) => l !== '').length]).toEqual([0, 12])
    const deletes = fake.writeCalls().filter((c) => c.kind === 'delete')
    expect(deletes.map((d) => (d.params.records ?? '').split(',').length)).toEqual([10, 2])
  })

  it('still prints what landed when a later batch fails', async () => {
    const fake = new FakeAirtable()
    const run = open(fake)
    await lines(run, '/s/new.jsonl', [...named(10), { fields: { Nope: 1 } }, ...named(2)])
    const [code, out, err] = await run(`airtable record create ${AT} < /s/new.jsonl`)
    expect(code).toBe(1)
    expect(out.split('\n').filter((l) => l !== '')).toHaveLength(10)
    expect(err).toBe(
      `Airtable API error (POST /${ROADMAP}/${FEATURES}): HTTP 422: ` +
        'UNKNOWN_FIELD_NAME: Unknown field name: "Nope"\n',
    )
    expect(fake.records[FEATURES]).toHaveLength(17)
  })

  it('never retries a write on a 502', async () => {
    const fake = new FakeAirtable({ faults: { 1: [502, 'BAD_GATEWAY'] } })
    const run = open(fake)
    const [code, out, err] = await run(`airtable record create ${AT} --fields '{}'`)
    expect([code, out]).toEqual([1, ''])
    expect(err).toContain('HTTP 502')
    expect(fake.writeCalls()).toHaveLength(1)
  })

  it('takes comment text from --text or stdin', async () => {
    const fake = new FakeAirtable()
    const run = open(fake)
    const [code, out] = await run(`airtable comment add ${AT} ${FIRST} --text 'from a flag'`)
    expect([code, (JSON.parse(out) as Row).text]).toEqual([0, 'from a flag'])
    await run(`printf 'piped\\n\\n' | airtable comment add ${AT} ${FIRST}`)
    await run(`printf 'bare' | airtable comment add ${AT} ${FIRST}`)
    expect(bodies(fake).map((b) => b.text)).toEqual(['from a flag', 'piped\n', 'bare'])
    const [, listed] = await run(`airtable comment list ${AT} ${FIRST}`)
    expect((JSON.parse(listed) as Row[])[0]?.text).toBe('bare')
  })

  it.each([
    [`airtable record create ${AT}`, '--fields or records on stdin are required'],
    [`airtable record create ${AT} --fields '[1]'`, '--fields must be a JSON object'],
    [`airtable record create ${AT} --fields '{bad'`, '--fields must be valid JSON'],
    [`airtable record create ${AT} --fields NaN`, '--fields must be valid JSON'],
    [`airtable record create ${AT} x --fields '{}'`, 'unrecognized arguments: x'],
    [`airtable record update ${AT} ${FIRST}`, '--fields is required with RECORD'],
    [`airtable record update ${AT} --fields '{}'`, 'RECORD is required with --fields'],
    [`airtable record update ${AT}`, 'RECORD --fields or records on stdin are required'],
    [`airtable record delete ${AT}`, 'RECORD or records on stdin are required'],
    [`airtable comment add ${AT} ${FIRST}`, '--text or text on stdin is required'],
    [`airtable comment add ${AT} ${FIRST} --text ''`, 'the comment text is empty'],
    [`airtable comment add ${AT} --text hi`, 'the following arguments are required: RECORD'],
  ])('refuses missing or malformed input: %s', async (line, message) => {
    const fake = new FakeAirtable()
    const run = open(fake)
    expect(await run(line)).toEqual(usage(message))
    expect(fake.calls).toEqual([])
  })

  it.each([
    ['create', '{"fields": {}}\n\nnot json\n', 'stdin line 3: not valid JSON'],
    ['create', '[]\n', 'stdin line 1: not a JSON object'],
    ['create', '{"id": "rec1", "fields": {}}\n', 'stdin line 1: unknown key "id"'],
    ['create', '{"fields": [1]}\n', 'stdin line 1: "fields" must be an object'],
    ['create', '{"record_id": "rec1"}\n', 'stdin line 1: "fields" is required'],
    ['update', '{"fields": {}}\n', 'stdin line 1: "record_id" is required'],
    ['update', '{"record_id": 7, "fields": {}}\n', 'stdin line 1: "record_id" must be a string'],
    ['update', '{"record_id": "rec1"}\n', 'stdin line 1: "fields" is required'],
    ['delete', '{"fields": {}}\n', 'stdin line 1: "record_id" is required'],
    ['delete', '{"record_id": "rec1", "fields": 3}\n', 'stdin line 1: "fields" must be an object'],
  ])('checks every stdin line before sending: %s %s', async (verb, text, message) => {
    const fake = new FakeAirtable()
    const run = open(fake)
    await run(`printf '%s' '${text}' > /s/in.jsonl`)
    expect(await run(`airtable record ${verb} ${AT} < /s/in.jsonl`)).toEqual(usage(message))
    expect(fake.calls).toEqual([])
  })

  it.each([
    `airtable record create --base ${OPS} --table t --fields '{}'`,
    `airtable record update --base ${OPS} --table t ${FIRST} --fields '{}'`,
    `airtable record delete --base ${OPS} --table t ${FIRST}`,
    `airtable comment add --base ${OPS} --table t ${FIRST} --text hi`,
  ])('refuses a write outside the scope unsent: %s', async (line) => {
    const fake = new FakeAirtable()
    const run = open(fake, { baseIds: [ROADMAP] })
    const verb = line.split(' ').slice(0, 3).join(' ')
    expect(await run(line)).toEqual([1, '', `${verb}: ${OPS}: Permission denied\n`])
    expect(fake.calls).toEqual([])
  })
})
