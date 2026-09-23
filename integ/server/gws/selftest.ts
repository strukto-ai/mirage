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

import { spawn } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import type { ChildProcessByStdio } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_RE } from '../kit/typescript/announce.ts'
import { start } from '../kit/typescript/serve.ts'
import { DEFAULT_RUN, DEFAULT_TENANT } from '../kit/typescript/tenant.ts'
import type { JsonValue } from '../kit/typescript/types.ts'
import { gwsFake } from './fake.ts'
import { cachedState, dropState, withState } from './store/cache.ts'
import { loadState } from './store/load.ts'
import { saveState } from './store/save.ts'

import { parseDriveQuery, matchQuery } from './drive/query.ts'
import { createDriveItem } from './drive/item.ts'
import { GwsState } from './store/state.ts'
import { newTab } from './sheets/grid.ts'
import { gridData } from './sheets/spreadsheet.ts'
import { sheetsBatchUpdate } from './sheets/batch.ts'
import { CELL_DATA, CELL_FORMAT, canonical } from './sheets/fields.ts'
import { badField, parseMask } from './sheets/mask.ts'
import { formatNumber } from './sheets/number.ts'
import { formatEventTime, slotMs } from './calendar/zone.ts'

// The corpus exercises the SURFACES of this fake heavily -- seven vendor APIs
// across the gdrive, gdocs, gsheets, gslides, gmail and gcal targets -- so this
// battery deliberately does not re-test them. What it holds is everything the
// corpus cannot see, which is the whole of what moving gws onto the kit's store
// bought: state that survives between requests because it is in SQLite rather
// than in a Map, a /reset scoped to the tenants it names, a fresh run served by
// copying an already-seeded template, and mint counters that survive that copy.
//
// The last one is the subtle one and the reason integ/prisma/gws.prisma carries
// a Counter model at all. A template copy hands a new run rows that were minted
// during the seed; a counter living in memory would restart at zero there and
// hand out an id the copied rows already use.

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const EPOCH = '2026-02-01T00:00:00Z'
const OTHER_EPOCH = '2031-07-04T00:00:00Z'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`gws selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue, want: JsonValue): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? a : `got ${a} want ${b}`)
}

interface Fake {
  child: ChildProcessByStdio<null, Readable, Readable>
  endpoint: string
  stderr: () => string
}

async function launch(): Promise<Fake> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0'],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  const first = await new Promise<string>((ok, bad) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl !== -1) ok(out.slice(0, nl))
    })
    child.on('exit', (code) => {
      bad(new Error(`fake exited ${String(code)} before announcing\n${err}`))
    })
  })
  check('announce line matches ANNOUNCE_RE', ANNOUNCE_RE.test(first), first)
  return { child, endpoint: first.split('=').slice(1).join('='), stderr: () => err }
}

type Obj = Record<string, JsonValue>

function obj(value: JsonValue | undefined): Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : {}
}

function arr(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function field(rows: JsonValue | undefined, name: string): string[] {
  return arr(rows).map((row) => String(obj(row)[name] ?? ''))
}

/** Each listed event's rendered `start.dateTime`, the zone check's subject. */
function startsOf(body: JsonValue): string[] {
  return arr(obj(body).items).map((row) => String(obj(obj(row).start)?.dateTime ?? ''))
}

async function api(
  url: string,
  tenant: string,
  init: RequestInit = {},
): Promise<{ status: number; body: JsonValue }> {
  const r = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-mirage-tenant': tenant,
      ...(init.headers ?? {}),
    },
  })
  const text = await r.text()
  let body: JsonValue = text
  try {
    body = JSON.parse(text) as JsonValue
  } catch {
    body = text
  }
  return { status: r.status, body }
}

const post = (url: string, tenant: string, body: JsonValue): ReturnType<typeof api> =>
  api(url, tenant, { method: 'POST', body: JSON.stringify(body) })

async function reset(base: string, body: JsonValue): Promise<number> {
  const r = await fetch(`${base}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.status
}

async function fileNames(base: string, tenant: string): Promise<string[]> {
  const got = await api(`${base}/drive/v3/files`, tenant)
  return field(obj(got.body).files, 'name')
}

const FORMS: JsonValue = [
  {
    title: 'Recall Survey',
    items: [{ itemId: 'serial', title: 'Serial' }],
    responses: [{ responseId: 'resp1', answers: {} }],
  },
]

function compatibilityDirect(): void {
  const st = new GwsState(Date.parse(EPOCH))
  const mime = 'application/vnd.google-apps.spreadsheet'
  const file = createDriveItem(st, "GDP2022 report and O'Brien", mime, [])
  let tab = newTab(0, 'Sheet1')
  tab.cells.set('0,0', 'a long headline for sizing')
  st.sheets.set(file.id, { title: file.name, tabs: [tab], nextSheetId: 1 })
  for (const [q, want] of [
    [`mimeType = '${mime}' and (name contains 'GDP2022' or fullText contains 'missing')`, true],
    ["name = 'absent' or name contains 'GDP2022' and trashed = false", true],
    ["(name = 'absent' or name contains 'GDP2022') and trashed = true", false],
    ["not (trashed = true or name = 'absent')", true],
    ["'root' in parents", true],
    ["not ('missing' in parents) and ('root' in parents or name = 'absent')", true],
    ["name contains 'O\\'Brien' and name contains ' and '", true],
  ] as const)
    eq(`direct Drive: ${q}`, matchQuery(st, file, parseDriveQuery(q)), want)
  for (const q of [
    "name = 'x' or",
    "(name = 'x'",
    "name = 'x')",
    "name = 'x' or unknown = 'y'",
    "name = 'unterminated",
    '()',
    "trashed = 'true'",
    "parents in 'root'",
    "name = 'absent' and parents in 'root'",
    "not (parents in 'root')",
    "'root' in 'parents'",
    "'root' in name",
  ]) {
    let refused = false
    try {
      parseDriveQuery(q)
    } catch (err) {
      refused = err instanceof Error
    }
    check(`direct Drive rejects ${q}`, refused)
  }
  const resize = (dimensions: Obj) =>
    sheetsBatchUpdate(st, file.id, [{ autoResizeDimensions: { dimensions } }])
  eq(
    'direct Sheets accepts column resize',
    resize({ sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 8 }).status,
    200,
  )
  tab = st.sheets.get(file.id)!.tabs[0]!
  check('direct Sheets sizes content', Number(tab.columnMeta['0']?.pixelSize) > 100)
  eq(
    'direct Sheets leaves cells unchanged',
    tab.cells.get('0,0') ?? '',
    'a long headline for sizing',
  )
  eq('direct Sheets accepts row resize', resize({ dimension: 'ROWS' }).status, 200)
  tab = st.sheets.get(file.id)!.tabs[0]!
  for (const dimensions of [
    { sheetId: 9, dimension: 'COLUMNS' },
    { dimension: 'INVALID' },
    { dimension: 'COLUMNS', startIndex: -1 },
    { dimension: 'COLUMNS', endIndex: 27 },
    { dimension: 'COLUMNS', startIndex: 8, endIndex: 3 },
    { dimension: 'COLUMNS', startIndex: 0.5 },
  ]) {
    eq('direct Sheets rejects invalid dimension range', resize(dimensions).status, 400)
  }
  const whole = gridData({ tab, startRow: 0, startCol: 0, endRow: null, endCol: null })
  check('direct Sheets exposes pixel metadata', arr(whole.columnMetadata).length === 26)
  for (const failure of [
    { unsupported: {} },
    { constructor: {} },
    { autoResizeDimensions: { dimensions: { sheetId: 99, dimension: 'ROWS' } } },
  ]) {
    const before = structuredClone(st.sheets.get(file.id))
    const modified = file.modifiedTime
    const ticks = st.ticks
    const failed = sheetsBatchUpdate(st, file.id, [
      { updateSpreadsheetProperties: { properties: { title: 'must not persist' } } },
      { addSheet: { properties: { title: 'must not exist' } } },
      { deleteDimension: { range: { sheetId: 0, dimension: 'COLUMNS', endIndex: 1 } } },
      { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: 'COLUMNS' } } },
      failure,
    ])
    eq('direct Sheets rejects entire mixed batch', failed.status, 400)
    check(
      'direct Sheets preserves all state on failure',
      isDeepStrictEqual(st.sheets.get(file.id), before),
    )
    eq(
      'direct Sheets preserves Drive metadata and clock',
      [file.name, file.modifiedTime, st.ticks],
      [before!.title, modified, ticks],
    )
  }
  const added = sheetsBatchUpdate(st, file.id, [
    { addSheet: { properties: { title: 'New tab' } } },
    {
      updateCells: {
        start: { sheetId: 1 },
        rows: [{ values: [{ userEnteredValue: { stringValue: 'new value' } }] }],
        fields: 'userEnteredValue',
      },
    },
    { autoResizeDimensions: { dimensions: { sheetId: 1, dimension: 'COLUMNS', endIndex: 1 } } },
  ])
  eq('direct Sheets commits dependent requests together', added.status, 200)
  eq(
    'direct Sheets reuses uncommitted sheet id and writes cells',
    st.sheets.get(file.id)!.tabs[1]!.cells.get('0,0') ?? '',
    'new value',
  )
  // Every row is what the live API answered on 2026-09-15: the offset is
  // the CALENDAR's, never the slot's, an already-offset value is re-rendered
  // rather than echoed, fractional seconds are dropped, and a slot with no
  // timeZone of its own is given the calendar's.
  for (const [calendarTz, slot, expected] of [
    // The issue's own payload: -12:00 in the slot, +08:00 on the wire.
    [
      'Asia/Hong_Kong',
      { timeZone: 'Etc/GMT+12', dateTime: '2026-09-25T20:59:00' },
      { timeZone: 'Etc/GMT+12', dateTime: '2026-09-26T16:59:00+08:00' },
    ],
    [
      'America/Los_Angeles',
      { timeZone: 'Etc/GMT+12', dateTime: '2026-09-25T20:59:00' },
      { timeZone: 'Etc/GMT+12', dateTime: '2026-09-26T01:59:00-07:00' },
    ],
    // DST is the calendar's, since the calendar is what renders.
    [
      'America/Los_Angeles',
      { timeZone: 'America/Los_Angeles', dateTime: '2026-01-01T10:00:00' },
      { timeZone: 'America/Los_Angeles', dateTime: '2026-01-01T10:00:00-08:00' },
    ],
    // An offset-bearing value is normalized too, not echoed.
    [
      'America/Los_Angeles',
      { timeZone: 'Etc/GMT+12', dateTime: '2026-09-26T08:59:00Z' },
      { timeZone: 'Etc/GMT+12', dateTime: '2026-09-26T01:59:00-07:00' },
    ],
    // No timeZone in the request: the calendar's fills it in.
    [
      'America/Los_Angeles',
      { dateTime: '2026-09-25T20:59:00+09:00' },
      // Key order is the spread's: a slot that named no zone gains one last.
      { dateTime: '2026-09-25T04:59:00-07:00', timeZone: 'America/Los_Angeles' },
    ],
    // Fractional seconds are dropped, and a half-hour zone still renders.
    [
      'Asia/Kolkata',
      { timeZone: 'Asia/Kolkata', dateTime: '2026-07-01T10:00:00.123' },
      { timeZone: 'Asia/Kolkata', dateTime: '2026-07-01T10:00:00+05:30' },
    ],
    // A zone whose historical offset carries SECONDS still renders a
    // valid RFC3339 offset. Europe/Paris ran at +00:09:21 until 1911,
    // which Intl reports as 9.35 minutes, and the raw value rendered
    // `+00:9.35` -- not a timestamp, and unparseable by every client.
    [
      'Europe/Paris',
      { timeZone: 'Europe/Paris', dateTime: '1900-01-01T00:00:00Z' },
      { timeZone: 'Europe/Paris', dateTime: '1900-01-01T00:09:00+00:09' },
    ],
  ] as const) {
    const result = formatEventTime(slot, calendarTz)
    eq('direct Calendar renders in the calendar zone', { ...result }, { ...expected })
    // To the SECOND, not the millisecond: Google drops the fraction, so a
    // rendering that kept it would be the divergence. Everything above the
    // fraction must survive, which is what a re-render could get wrong.
    eq(
      'direct Calendar preserves the instant to the second',
      Math.floor((slotMs(result, calendarTz) ?? 0) / 1000),
      Math.floor((slotMs(slot, calendarTz) ?? 0) / 1000),
    )
  }
  eq(
    'direct Calendar leaves all-day values alone',
    { ...formatEventTime({ date: '2026-07-01' }, 'Asia/Hong_Kong') },
    { date: '2026-07-01' },
  )
}

// The Sheets pieces every format request leans on, each pinned to what the
// live API answered on 2026-09-21.
function sheetsFormatsDirect(): void {
  eq(
    'direct Sheets mask distributes a parenthesized list',
    parseMask('userEnteredFormat(backgroundColor,textFormat.italic),note').map((p) => [...p]),
    [
      ['userEnteredFormat', 'backgroundColor'],
      ['userEnteredFormat', 'textFormat', 'italic'],
      ['note'],
    ],
  )
  eq(
    'direct Sheets mask names the first bad segment in snake_case',
    badField(parseMask('userEnteredFormat.textFormatX.bold'), CELL_DATA),
    'userEnteredFormat.text_format_x',
  )
  eq('direct Sheets mask accepts a whole message', badField(parseMask('*'), CELL_DATA), null)
  for (const [value, format, want] of [
    [0.685, { type: 'PERCENT', pattern: '0.0%' }, '68.5%'],
    [0.62, { type: 'PERCENT', pattern: '0.0%' }, '62.0%'],
    [0.62, { type: 'PERCENT' }, '62%'],
    [1234.5, { type: 'NUMBER', pattern: '#,##0.00' }, '1,234.50'],
    [-5, { type: 'CURRENCY' }, '-$5.00'],
    [12345, { type: 'SCIENTIFIC', pattern: '0.00E+00' }, '1.23E+04'],
    [1.005, { type: 'NUMBER', pattern: '0.00' }, '1.01'],
    [-3, { type: 'NUMBER', pattern: '0;(0)' }, '(3)'],
  ] as const) {
    eq(`direct Sheets formats ${String(value)} as ${want}`, formatNumber(value, format), want)
  }
  eq(
    'direct Sheets shows a NUMBER with no pattern plain',
    formatNumber(1234.5, { type: 'NUMBER' }),
    null,
  )
  eq('direct Sheets leaves dates unmodeled', formatNumber(1, { type: 'DATE' }), null)
  eq(
    'direct Sheets quantizes a color and mirrors its style',
    canonical({ backgroundColor: { red: 1, green: 0.9, blue: 0 } }, CELL_FORMAT),
    {
      backgroundColor: { red: 1, green: 0.8980392 },
      backgroundColorStyle: { rgbColor: { red: 1, green: 0.8980392 } },
    },
  )
}

async function compatibilityHttp(at: string): Promise<void> {
  const base = `${at}/_run/compat1077`
  check('compatibility world seeds', (await reset(base, { tenants: ['t1'], epoch: EPOCH })) === 200)
  const sheet = await post(`${base}/v4/spreadsheets`, 't1', {
    properties: { title: 'GDP2022 report' },
  })
  check('HTTP creates spreadsheet', sheet.status === 200)
  const id = String(obj(sheet.body).spreadsheetId)
  const q =
    "mimeType = 'application/vnd.google-apps.spreadsheet' and (name contains 'GDP2022' or fullText contains 'GDP2022')"
  const found = await api(`${base}/drive/v3/files?${new URLSearchParams({ q })}`, 't1')
  check('HTTP Drive accepts grouped query', found.status === 200)
  eq('HTTP Drive returns matching spreadsheet', field(obj(found.body).files, 'id'), [id])
  const invalid = await api(
    `${base}/drive/v3/files?${new URLSearchParams({ q: "name='x' or invalid='y'" })}`,
    't1',
  )
  eq('HTTP Drive validates every branch', invalid.status, 400)
  for (const q of ["parents in 'root'", "name = 'absent' and (parents in 'root')"]) {
    const reversed = await api(`${base}/drive/v3/files?${new URLSearchParams({ q })}`, 't1')
    eq('HTTP Drive rejects reversed membership', reversed.status, 400)
  }
  const member = await api(
    `${base}/drive/v3/files?${new URLSearchParams({ q: "'root' in parents" })}`,
    't1',
  )
  eq('HTTP Drive accepts value-first membership', field(obj(member.body).files, 'id'), [id])
  const written = await api(`${base}/v4/spreadsheets/${id}/values/Sheet1!A1`, 't1', {
    method: 'PUT',
    body: JSON.stringify({ values: [['a long headline for sizing', 'untouched']] }),
  })
  eq('HTTP writes cells', written.status, 200)
  const resized = await post(`${base}/v4/spreadsheets/${id}:batchUpdate`, 't1', {
    requests: [
      {
        autoResizeDimensions: {
          dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        },
      },
    ],
  })
  eq('HTTP Sheets accepts resize and replies', obj(resized.body).replies ?? null, [{}])
  const read = await api(`${base}/v4/spreadsheets/${id}?includeGridData=true`, 't1')
  const data = obj(arr(obj(arr(obj(read.body).sheets)[0]).data)[0])
  const metadata = arr(data.columnMetadata)
  check('HTTP Sheets persists resized metadata', Number(obj(metadata[0]).pixelSize) > 100)
  eq('HTTP Sheets leaves the next column alone', obj(metadata[1]).pixelSize ?? null, 100)
  const values = await api(`${base}/v4/spreadsheets/${id}/values/Sheet1!A1:B1`, 't1')
  eq('HTTP Sheets preserves cell contents', obj(values.body).values ?? null, [
    ['a long headline for sizing', 'untouched'],
  ])
  const driveBefore = await api(`${base}/drive/v3/files/${id}`, 't1')
  const failedBatch = await post(`${base}/v4/spreadsheets/${id}:batchUpdate`, 't1', {
    requests: [
      { updateSpreadsheetProperties: { properties: { title: 'must not persist' } } },
      { addSheet: { properties: { title: 'must not exist' } } },
      {
        updateCells: {
          start: { sheetId: 0 },
          rows: [{ values: [{ userEnteredValue: { stringValue: 'short' } }] }],
          fields: 'userEnteredValue',
        },
      },
      { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: 'COLUMNS', endIndex: 1 } } },
      { unsupported: {} },
    ],
  })
  eq('HTTP Sheets rejects a mixed batch', failedBatch.status, 400)
  eq(
    'HTTP Sheets does not persist failed batch changes',
    (await api(`${base}/v4/spreadsheets/${id}?includeGridData=true`, 't1')).body,
    read.body,
  )
  eq(
    'HTTP Sheets preserves linked Drive metadata on failure',
    (await api(`${base}/drive/v3/files/${id}`, 't1')).body,
    driveBefore.body,
  )
  const events = `${base}/calendar/v3/calendars/primary/events`
  const body = {
    summary: 'Deadline reminder',
    start: { dateTime: '2026-09-25T20:59:00', timeZone: 'Etc/GMT+12' },
    end: { dateTime: '2026-09-25T21:59:00', timeZone: 'Etc/GMT+12' },
  }
  const created = await post(events, 't1', body)
  const eventId = String(obj(created.body).id)
  // The seeded calendar is Asia/Hong_Kong, and the live API renders in the
  // CALENDAR's zone: 20:59 at UTC-12 is 08:59Z, which is 16:59 at +08:00.
  // The slot's own Etc/GMT+12 rides along as the event's declared zone.
  const expected = { dateTime: '2026-09-26T16:59:00+08:00', timeZone: 'Etc/GMT+12' }
  eq('HTTP Calendar insert returns an offset', obj(created.body).start ?? null, expected)
  const fetched = await api(`${events}/${eventId}`, 't1')
  eq('HTTP Calendar get returns the same offset', obj(fetched.body).start ?? null, expected)
  const listed = await api(
    `${events}?timeMin=2026-09-26T08:58:00Z&timeMax=2026-09-26T09:00:00Z`,
    't1',
  )
  eq(
    'HTTP Calendar list filters and returns the same instant',
    obj(arr(obj(listed.body).items)[0]).start ?? null,
    expected,
  )
  for (const method of ['PUT', 'PATCH']) {
    const updated = await api(`${events}/${eventId}`, 't1', { method, body: JSON.stringify(body) })
    eq(`HTTP Calendar ${method} returns an offset`, obj(updated.body).start ?? null, expected)
  }
  for (const method of ['PUT', 'PATCH']) {
    for (const status of ['tentative', 'cancelled']) {
      const updated = await api(`${events}/${eventId}`, 't1', {
        method,
        body: JSON.stringify(method === 'PUT' ? { ...body, status } : { status }),
      })
      eq(`HTTP Calendar ${method} accepts ${status}`, updated.status, 200)
      eq(
        `HTTP Calendar ${method} returns supplied status`,
        obj(updated.body).status ?? null,
        status,
      )
      const fetched = await api(`${events}/${eventId}`, 't1')
      eq(
        `HTTP Calendar ${method} persists supplied status`,
        obj(fetched.body).status ?? null,
        status,
      )
      const visible = await api(events, 't1')
      eq(
        'HTTP Calendar list respects cancellation',
        field(obj(visible.body).items, 'id'),
        status === 'cancelled' ? [] : [eventId],
      )
      const deleted = await api(`${events}?showDeleted=true`, 't1')
      eq(
        'HTTP Calendar showDeleted includes current status',
        field(obj(deleted.body).items, 'status'),
        [status],
      )
      const freeBusy = await post(`${base}/calendar/v3/freeBusy`, 't1', {
        timeMin: '2026-09-26T00:00:00Z',
        timeMax: '2026-09-27T00:00:00Z',
        items: [{ id: 'primary' }],
      })
      eq(
        'HTTP Calendar freeBusy respects cancellation',
        arr(obj(obj(obj(freeBusy.body).calendars).primary).busy).length,
        status === 'cancelled' ? 0 : 1,
      )
    }
    const before = (await api(`${events}/${eventId}`, 't1')).body
    for (const status of ['invalid', 7]) {
      const invalid = await api(`${events}/${eventId}`, 't1', {
        method,
        body: JSON.stringify({ ...body, status }),
      })
      eq(`HTTP Calendar ${method} rejects invalid status`, invalid.status, 400)
      eq(
        'HTTP Calendar invalid status preserves the event',
        (await api(`${events}/${eventId}`, 't1')).body,
        before,
      )
    }
    const omitted = await api(`${events}/${eventId}`, 't1', { method, body: JSON.stringify(body) })
    eq(
      `HTTP Calendar ${method} handles omitted status`,
      obj(omitted.body).status ?? null,
      method === 'PUT' ? 'confirmed' : 'cancelled',
    )
  }
  // Every wording below was read off the live API on 2026-09-15, because
  // each one is a distinct message and guessing them makes the fake teach
  // a caller to handle an error Google never sends.
  for (const [label, start, end, message] of [
    [
      'a dateTime with neither offset nor zone',
      { dateTime: '2026-09-25T20:59:00' },
      { dateTime: '2026-09-25T21:59:00' },
      'Missing time zone definition for start time.',
    ],
    [
      'an unreadable dateTime',
      { dateTime: 'not-a-time', timeZone: 'UTC' },
      { dateTime: '2026-09-25T21:59:00Z' },
      'Bad Request',
    ],
    [
      'a date the calendar does not have',
      { dateTime: '2026-02-30T20:59:00Z' },
      { dateTime: '2026-02-30T21:59:00Z' },
      'Bad Request',
    ],
    [
      'an end before its start',
      { dateTime: '2026-09-25T21:59:00Z' },
      { dateTime: '2026-09-25T20:59:00Z' },
      'The specified time range is empty.',
    ],
    [
      'an all-day end before its start',
      { date: '2026-09-26' },
      { date: '2026-09-25' },
      'The specified time range is empty.',
    ],
  ] as const) {
    const refused = await post(events, 't1', { summary: label, start, end })
    eq(`HTTP Calendar refuses ${label}`, refused.status, 400)
    eq(
      `HTTP Calendar names why it refused ${label}`,
      obj(obj(refused.body).error).message ?? null,
      message,
    )
  }
  // Equal ends are accepted, timed and all-day alike: the rule is `<`.
  for (const [label, slot] of [
    ['timed', { dateTime: '2026-09-25T10:00:00Z' }],
    ['all-day', { date: '2026-09-25' }],
  ] as const) {
    const flat = await post(events, 't1', {
      summary: `zero length ${label}`,
      start: slot,
      end: slot,
    })
    eq(`HTTP Calendar accepts a zero-length ${label} event`, flat.status, 200)
  }
  // A request that names no zone is answered with the calendar's.
  const bare = await post(events, 't1', {
    summary: 'zoneless request',
    start: { dateTime: '2026-09-25T20:59:00+09:00' },
    end: { dateTime: '2026-09-25T21:59:00+09:00' },
  })
  eq('HTTP Calendar fills timeZone from the calendar', obj(bare.body).start ?? null, {
    dateTime: '2026-09-25T19:59:00+08:00',
    timeZone: 'Asia/Hong_Kong',
  })
  // events.list renders in the zone its `timeZone` parameter asks for,
  // which is also the zone it reports. Rendering in the calendar's while
  // reporting the asked-for one hands a caller times it cannot group by
  // the local date it was told to read them in.
  const inUtc = await api(`${events}?timeZone=UTC&q=zoneless request`, 't1')
  eq(
    'HTTP Calendar list reports the zone it was asked for',
    obj(inUtc.body).timeZone ?? null,
    'UTC',
  )
  eq('HTTP Calendar list renders its items in that zone', startsOf(inUtc.body), [
    '2026-09-25T11:59:00+00:00',
  ])
  const perCal = await api(`${events}?q=zoneless request`, 't1')
  eq('and falls back to the calendar zone when none was asked for', startsOf(perCal.body), [
    '2026-09-25T19:59:00+08:00',
  ])
  // Rendering in a zone means handing it to Intl, which throws for one
  // it cannot resolve; the door refuses rather than crashing the read.
  const badZone = await api(`${events}?timeZone=Not/AZone`, 't1')
  eq('HTTP Calendar list refuses a zone it cannot resolve', badZone.status, 400)
}

// spreadsheets.get narrows to `ranges` the way the live API does: a small
// read of a big sheet stays small, an offset range says where it starts,
// each range gets its own GridData, and only the tabs asked for come back.
async function gridRangesHttp(at: string): Promise<void> {
  const base = `${at}/_run/ranges1151`
  check('ranges world seeds', (await reset(base, { tenants: ['t1'], epoch: EPOCH })) === 200)
  const made = await post(`${base}/v4/spreadsheets`, 't1', { properties: { title: 'Games' } })
  const id = String(obj(made.body).spreadsheetId)
  const games = Array.from({ length: 1313 }, (_, r) =>
    Array.from({ length: 8 }, (_, c) => `r${String(r + 1)}c${String(c + 1)}`),
  )
  const filled = await api(`${base}/v4/spreadsheets/${id}/values/Sheet1!A1`, 't1', {
    method: 'PUT',
    body: JSON.stringify({ values: games }),
  })
  eq('ranges: fills 1313 rows', filled.status, 200)
  const second = await post(`${base}/v4/spreadsheets/${id}:batchUpdate`, 't1', {
    requests: [{ addSheet: { properties: { title: 'Notes' } } }],
  })
  eq('ranges: adds a second tab', second.status, 200)
  await api(`${base}/v4/spreadsheets/${id}/values/Notes!A1`, 't1', {
    method: 'PUT',
    body: JSON.stringify({ values: [['note']] }),
  })
  const get = (query: string): ReturnType<typeof api> =>
    api(`${base}/v4/spreadsheets/${id}?${query}`, 't1')
  const sheetsOf = (body: JsonValue): Obj[] => arr(obj(body).sheets).map(obj)
  const formatted = (grid: Obj): JsonValue[] =>
    arr(grid.rowData).map((row) => field(obj(row).values, 'formattedValue'))

  const all = await get('includeGridData=true')
  eq('ranges: none asked returns every tab', sheetsOf(all.body).length, 2)
  eq(
    'ranges: and the whole grid',
    arr(obj(arr(sheetsOf(all.body)[0]?.data)[0]).rowData).length,
    1313,
  )

  const head = await get(`includeGridData=true&ranges=${encodeURIComponent('Sheet1!A1:H2')}`)
  eq('ranges: A1:H2 names one tab', sheetsOf(head.body).length, 1)
  const headGrid = obj(arr(sheetsOf(head.body)[0]?.data)[0])
  eq('ranges: A1:H2 returns two rows', arr(headGrid.rowData).length, 2)
  eq('ranges: of eight cells', arr(obj(arr(headGrid.rowData)[1]).values).length, 8)
  eq('ranges: with metadata for the range only', arr(headGrid.rowMetadata).length, 2)
  eq('ranges: in both dimensions', arr(headGrid.columnMetadata).length, 8)
  check(
    'ranges: a zero start is omitted',
    !('startRow' in headGrid) && !('startColumn' in headGrid),
  )
  check(
    'ranges: the reply stays small',
    JSON.stringify(head.body).length * 100 < JSON.stringify(all.body).length,
  )

  const offset = await get(`includeGridData=true&ranges=${encodeURIComponent('Sheet1!C5:D6')}`)
  const offsetGrid = obj(arr(sheetsOf(offset.body)[0]?.data)[0])
  eq('ranges: an offset range reports startRow', offsetGrid.startRow ?? null, 4)
  eq('ranges: and startColumn', offsetGrid.startColumn ?? null, 2)
  eq('ranges: and holds exactly its cells', formatted(offsetGrid), [
    ['r5c3', 'r5c4'],
    ['r6c3', 'r6c4'],
  ])

  const many = await get(
    `includeGridData=true&ranges=${encodeURIComponent('Sheet1!A1:B1')}&ranges=${encodeURIComponent('Sheet1!H1313:H1313')}&ranges=${encodeURIComponent('Notes!A1')}`,
  )
  eq(
    'ranges: two tabs named, in tab order',
    sheetsOf(many.body).map((t) => String(obj(t.properties).title)),
    ['Sheet1', 'Notes'],
  )
  const firstTab = arr(sheetsOf(many.body)[0]?.data).map(obj)
  eq('ranges: one GridData per range of a tab', firstTab.length, 2)
  eq('ranges: in request order', firstTab.map(formatted), [[['r1c1', 'r1c2']], [['r1313c8']]])
  eq('ranges: the last row keeps its offset', firstTab[1]?.startRow ?? null, 1312)

  const notes = await get(`includeGridData=true&ranges=Notes`)
  eq(
    'ranges: a bare tab name selects that tab',
    sheetsOf(notes.body).map((t) => String(obj(t.properties).title)),
    ['Notes'],
  )
  eq('ranges: keeping its real index', obj(sheetsOf(notes.body)[0]?.properties).index ?? null, 1)
  eq('ranges: whole', formatted(obj(arr(sheetsOf(notes.body)[0]?.data)[0])), [['note']])

  const beyond = await get(
    `includeGridData=true&ranges=${encodeURIComponent('Sheet1!A2000:B2001')}`,
  )
  eq(
    'ranges: past the data is an empty grid',
    arr(obj(arr(sheetsOf(beyond.body)[0]?.data)[0]).rowData),
    [],
  )

  const bare = await get(`ranges=${encodeURIComponent('Notes!A1')}`)
  eq('ranges: without includeGridData still selects tabs', sheetsOf(bare.body).length, 1)
  check('ranges: and still carries no data', !('data' in (sheetsOf(bare.body)[0] ?? {})))

  const bad = await get(`includeGridData=true&ranges=${encodeURIComponent('Missing!A1')}`)
  eq('ranges: an unknown tab is a 400', bad.status, 400)
}

async function driveMoveHttp(at: string): Promise<void> {
  const base = `${at}/_run/drivemove`
  check('drive move world seeds', (await reset(base, { tenants: ['t1'], epoch: EPOCH })) === 200)
  const FOLDER = 'application/vnd.google-apps.folder'
  const idOf = async (path: string, body: JsonValue): Promise<string> =>
    String(obj((await post(`${base}${path}`, 't1', body)).body).id)
  const patch = (id: string, query: string, body: JsonValue = {}): ReturnType<typeof api> =>
    api(`${base}/drive/v3/files/${id}?${query}`, 't1', {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
  const listed = async (driveId?: string): Promise<string[]> => {
    const query = driveId === undefined ? '' : `?driveId=${driveId}&corpora=drive`
    const got = await api(`${base}/drive/v3/files${query}`, 't1')
    return field(obj(got.body).files, 'name')
      .filter((name) => name !== 'Team' && name !== 'Other')
      .sort()
  }
  const refusal = (reply: { status: number; body: JsonValue }): JsonValue => [
    reply.status,
    String(obj(arr(obj(obj(reply.body).error).errors)[0]).reason),
  ]
  const team = await idOf('/drive/v3/drives', { name: 'Team' })
  const other = await idOf('/drive/v3/drives', { name: 'Other' })
  const stay = await idOf('/drive/v3/files', { name: 'Stay', mimeType: FOLDER })
  const loose = await idOf('/drive/v3/files', { name: 'Loose', mimeType: 'text/plain' })
  const carry = await idOf('/drive/v3/files', { name: 'Carry', mimeType: FOLDER, parents: [team] })
  await idOf('/drive/v3/files', { name: 'Child', mimeType: 'text/plain', parents: [carry] })

  eq(
    'drive move: a My Drive folder cannot move into a shared drive',
    refusal(await patch(stay, `addParents=${team}`)),
    [403, 'teamDrivesFolderMoveInNotSupported'],
  )
  eq('drive move: a My Drive file can', (await patch(loose, `addParents=${team}`)).status, 200)
  eq('drive move: the shared drive lists it', await listed(team), ['Carry', 'Child', 'Loose'])
  eq('drive move: My Drive keeps the refused folder', await listed(), ['Stay'])
  eq(
    'drive move: a folder moves between shared drives',
    (await patch(carry, `addParents=${other}`)).status,
    200,
  )
  eq('drive move: its child goes with it', await listed(other), ['Carry', 'Child'])
  eq('drive move: and leaves the drive it came from', await listed(team), ['Loose'])
  eq('drive move: it moves out to My Drive', (await patch(carry, 'addParents=root')).status, 200)
  eq('drive move: with its child', await listed(), ['Carry', 'Child', 'Stay'])
  eq(
    'drive move: files.update renames a drive root',
    (await patch(team, '', { name: 'Team' })).status,
    200,
  )
  eq('drive move: a drive root cannot move', refusal(await patch(team, 'addParents=root')), [
    403,
    'insufficientFilePermissions',
  ])
  eq('drive move: the drive still holds its files', await listed(team), ['Loose'])
  for (const id of [team, other]) {
    await api(`${base}/drive/v3/drives/${id}`, 't1', { method: 'DELETE' })
  }
  eq('drive move: deleting the drives keeps what left them', await listed(), [
    'Carry',
    'Child',
    'Stay',
  ])
}

async function main(): Promise<void> {
  compatibilityDirect()
  sheetsFormatsDirect()
  const fake = await launch()
  const at = fake.endpoint
  const seed = { tenants: ['t1'], epoch: EPOCH, extras: { forms: FORMS } }
  try {
    await compatibilityHttp(at)
    await gridRangesHttp(at)
    await driveMoveHttp(at)
    // ---- the base world is fixture rows, not constructor state
    check('a bare /reset seeds', (await reset(at, { tenants: ['t1'], epoch: EPOCH })) === 200)
    const labels = await api(`${at}/gmail/v1/users/me/labels`, 't1')
    eq('the four system labels are fixture rows', field(obj(labels.body).labels, 'id'), [
      'INBOX',
      'SENT',
      'UNREAD',
      'TRASH',
    ])
    const cals = await api(`${at}/calendar/v3/users/me/calendarList`, 't1')
    eq('the primary calendar is a fixture row', field(obj(cals.body).items, 'id'), [
      'integ@example.com',
    ])
    eq('and carries the non-UTC default zone', field(obj(cals.body).items, 'timeZone'), [
      'Asia/Hong_Kong',
    ])

    // ---- extras: the two states no API call can produce
    check('extras seed a form', (await reset(at, seed)) === 200)
    eq('the seeded form is a Drive file', await fileNames(at, 't1'), ['Recall Survey'])
    const form = await api(`${at}/v1/forms/form0001`, 't1')
    eq('whose formId is its Drive file id', String(obj(form.body).formId), 'form0001')
    const responses = await api(`${at}/v1/forms/form0001/responses`, 't1')
    eq('readable through responses.list', field(obj(responses.body).responses, 'responseId'), [
      'resp1',
    ])
    eq(
      'and the seeded item keeps the itemId the fixture gave it',
      field(obj(form.body).items, 'itemId'),
      ['serial'],
    )
    const badExtras = await reset(at, { tenants: ['t1'], extras: { calendars: 7 } })
    check('extras.calendars that is not a list is a 400', badExtras === 400, String(badExtras))
    const unknown = await reset(at, { tenants: ['t1'], extras: { workspace: 'x' } })
    check('an unknown extras key is a 400', unknown === 400, String(unknown))
    // Every timed event renders in its calendar's zone, so a zone Intl
    // cannot resolve would throw a RangeError out of a later read. Both
    // doors that set one refuse it here instead.
    const badDefault = await reset(at, {
      tenants: ['t1'],
      extras: { calendarTimeZone: 'Not/AZone' },
    })
    check('a calendarTimeZone that is not a zone is a 400', badDefault === 400, String(badDefault))
    const badCalZone = await reset(at, {
      tenants: ['t1'],
      extras: { calendars: [{ id: 'z@example.com', summary: 'z', timeZone: 'Not/AZone' }] },
    })
    check(
      'a seeded calendar zone that is not a zone is a 400',
      badCalZone === 400,
      String(badCalZone),
    )

    // ---- the clock is pinned and PERSISTED, which is what makes it resume
    check('reseed', (await reset(at, seed)) === 200)
    const made = await post(`${at}/v1/documents`, 't1', { title: 'A' })
    const files = await api(`${at}/drive/v3/files`, 't1')
    const times = field(obj(files.body).files, 'createdTime')
    eq('the seed consumed the first tick, the doc the second', times, [
      '2026-02-01T00:00:01.000Z',
      '2026-02-01T00:00:02.000Z',
    ])
    check(
      'the document minted from the persisted counter',
      String(obj(made.body).documentId) === 'doc0001',
      String(obj(made.body).documentId),
    )

    // ---- state survives BETWEEN requests, which is the whole port
    eq('a write in one request is visible in the next', await fileNames(at, 't1'), [
      'Recall Survey',
      'A',
    ])

    // ---- generateIds is a GET that writes, so its advance has to persist
    const g1 = await api(`${at}/drive/v3/files/generateIds?count=2`, 't1')
    const g2 = await api(`${at}/drive/v3/files/generateIds?count=2`, 't1')
    const ids1 = arr(obj(g1.body).ids).map(String)
    const ids2 = arr(obj(g2.body).ids).map(String)
    check(
      'generateIds never repeats across requests',
      ids1.every((id) => !ids2.includes(id)),
      `${ids1.join(',')} then ${ids2.join(',')}`,
    )

    // ---- one run, two tenants
    check('a second tenant seeds', (await reset(at, { ...seed, tenants: ['t2'] })) === 200)
    eq('the second tenant sees only its own seed', await fileNames(at, 't2'), ['Recall Survey'])
    eq('and the first tenant still has its doc', await fileNames(at, 't1'), ['Recall Survey', 'A'])
    // This is the one gws could not do at all before: its /reset replaced the
    // whole run's world, so a second host resetting wiped the first host's.
    check('resetting t2 again', (await reset(at, { ...seed, tenants: ['t2'] })) === 200)
    eq("a scoped reset leaves the other tenant's world", await fileNames(at, 't1'), [
      'Recall Survey',
      'A',
    ])

    // ---- two runs, same tenant name
    const ra = `${at}/_run/ra`
    const rb = `${at}/_run/rb`
    check('run ra seeds', (await reset(ra, seed)) === 200)
    check('run rb seeds', (await reset(rb, seed)) === 200)
    await post(`${ra}/v1/documents`, 't1', { title: 'only-in-ra' })
    eq('a run is its own world', await fileNames(rb, 't1'), ['Recall Survey'])
    eq('run ra kept its own', await fileNames(ra, 't1'), ['Recall Survey', 'only-in-ra'])

    // ---- a fresh run is a COPY of the seeded template
    const rc = `${at}/_run/rc`
    check('run rc seeds from the cached template', (await reset(rc, seed)) === 200)
    eq('the copy holds the seeded rows', await fileNames(rc, 't1'), ['Recall Survey'])
    const copied = await post(`${rc}/v1/forms`, 't1', { info: { title: 'Fresh' } })
    // The whole reason Counter is a table. An in-memory minter restarts at zero
    // inside the copy and hands out form0001, which the copied rows already use.
    check(
      'a mint counter survives into the copy',
      String(obj(copied.body).formId) === 'form0002',
      String(obj(copied.body).formId),
    )
    const direct = await post(`${ra}/v1/forms`, 't1', { info: { title: 'Fresh' } })
    eq(
      'and the copy agrees with the run that built the template',
      String(obj(copied.body).formId),
      String(obj(direct.body).formId),
    )

    // ---- the epoch is part of the template key
    const rd = `${at}/_run/rd`
    check(
      'a run on another epoch seeds',
      (await reset(rd, { ...seed, epoch: OTHER_EPOCH })) === 200,
    )
    const other = await api(`${rd}/drive/v3/files`, 't1')
    eq(
      'a second epoch does not reuse the first epoch template',
      field(obj(other.body).files, 'createdTime'),
      ['2031-07-04T00:00:01.000Z'],
    )

    // ---- gws keeps its own path compiler, and both divergences are load-bearing
    const slashed = await api(`${at}/drive/v3/files/`, 't1')
    check('a trailing slash is not the same route', slashed.status === 404, String(slashed.status))
    const colon = await post(`${at}/v1/documents/a:b:batchUpdate`, 't1', { requests: [] })
    check('an id holding a colon is not read as one', colon.status === 404, String(colon.status))
    // One 404 shape, google's, whether the path matched no route at all or
    // matched one whose in-segment verb is not served. The kit's own `unrouted`
    // body would have been a second shape for the same condition.
    eq(
      'an unrouted path answers in google envelope',
      String(obj(obj(slashed.body).error).message),
      'Unknown route: GET /drive/v3/files/',
    )
    eq(
      'and so does an unserved in-segment verb',
      String(obj(obj(colon.body).error).message),
      'Unknown route: POST /v1/documents/a:b:batchUpdate',
    )

    // ---- an event time is validated at the door, never stored as typed
    const rv = `${at}/_run/rv`
    check('run rv seeds', (await reset(rv, seed)) === 200)
    const events = `${rv}/calendar/v3/calendars/primary/events`
    const timed = (summary: string, start: JsonValue, end: JsonValue): JsonValue => ({
      summary,
      start,
      end,
    })
    const zulu = await post(
      events,
      't1',
      timed('zulu', { dateTime: '2026-02-03T10:00:00Z' }, { dateTime: '2026-02-03T11:00:00Z' }),
    )
    check('an RFC3339 time with Z is accepted', zulu.status === 200, JSON.stringify(zulu.body))
    const offset = await post(
      events,
      't1',
      timed(
        'offset',
        { dateTime: '2026-02-03T18:30:00+08:00' },
        { dateTime: '2026-02-03T06:00:00-05:00' },
      ),
    )
    check('numeric offsets are accepted', offset.status === 200, JSON.stringify(offset.body))
    const zoned = await post(
      events,
      't1',
      timed(
        'zoned',
        { dateTime: '2026-02-03T09:00:00', timeZone: 'Europe/Paris' },
        { dateTime: '2026-02-03T09:30:00', timeZone: 'Europe/Paris' },
      ),
    )
    check(
      'an offset-free time naming an IANA zone is accepted',
      zoned.status === 200,
      JSON.stringify(zoned.body),
    )
    const listed = async (): Promise<number> =>
      arr(obj((await api(events, 't1')).body).items).length
    const before = await listed()
    const refused = async (
      name: string,
      start: JsonValue,
      end: JsonValue,
      message: string,
    ): Promise<void> => {
      const r = await post(events, 't1', timed('refused', start, end))
      const err = obj(obj(r.body).error)
      check(
        name,
        r.status === 400 &&
          err.status === 'INVALID_ARGUMENT' &&
          String(err.message).includes(message),
        `${String(r.status)} ${JSON.stringify(r.body)}`,
      )
    }
    await refused(
      'a string that is not a date is a 400',
      { dateTime: 'not-a-date' },
      { dateTime: 'not-a-date' },
      // A value the parser cannot read at all earns a bare `Bad Request`:
      // Google names neither the field nor the value.
      'Bad Request',
    )
    await refused(
      'a day February does not have is a 400',
      { dateTime: '2026-02-30T10:00:00Z' },
      { dateTime: '2026-02-30T11:00:00Z' },
      'Bad Request',
    )
    await refused(
      'an offset-free time with no zone is a 400',
      { dateTime: '2026-02-03T10:00:00' },
      { dateTime: '2026-02-03T11:00:00' },
      // A readable wall clock with nothing to resolve it by is its own
      // refusal, distinct from an unreadable value.
      'Missing time zone definition for start time.',
    )
    await refused(
      'a zone IANA does not know is a 400',
      { dateTime: '2026-02-03T10:00:00', timeZone: 'Mars/Olympus' },
      { dateTime: '2026-02-03T11:00:00', timeZone: 'Mars/Olympus' },
      'Invalid time zone definition for start time.',
    )
    await refused(
      'an all-day date not spelled yyyy-mm-dd is a 400',
      { date: '2026-2-3' },
      { date: '2026-02-04' },
      'Bad Request',
    )
    await refused(
      'an all-day date the calendar does not have is a 400',
      { date: '2026-02-30' },
      { date: '2026-03-01' },
      'Bad Request',
    )
    await refused(
      'a slot naming both date and dateTime is a 400',
      { date: '2026-02-03', dateTime: '2026-02-03T10:00:00Z' },
      { dateTime: '2026-02-03T11:00:00Z' },
      'Invalid start time.',
    )
    eq('a refused create left nothing behind', await listed(), before)

    const id = String(obj(zulu.body).id)
    const patched = await api(`${events}/${id}`, 't1', {
      method: 'PATCH',
      body: JSON.stringify({ start: { dateTime: 'not-a-date' } }),
    })
    check('a patch to a malformed time is a 400', patched.status === 400, String(patched.status))
    const kept = await api(`${events}/${id}`, 't1')
    // The stored instant is untouched; the rendering is the calendar's, as
    // it is on every read (10:00Z is 18:00 in Asia/Hong_Kong).
    eq('and the stored event is unchanged', obj(kept.body).start ?? null, {
      dateTime: '2026-02-03T18:00:00+08:00',
      timeZone: 'Asia/Hong_Kong',
    })

    const window = await api(
      `${events}?timeMin=2026-02-03T00:00:00Z&timeMax=2026-02-04T00:00:00Z&orderBy=startTime`,
      't1',
    )
    eq(
      'a bounded, sorted list orders the three by instant',
      field(obj(window.body).items, 'summary'),
      ['zoned', 'zulu', 'offset'],
    )
    const fb = await post(`${rv}/calendar/v3/freeBusy`, 't1', {
      timeMin: '2026-02-03T00:00:00Z',
      timeMax: '2026-02-04T00:00:00Z',
      items: [{ id: 'primary' }],
    })
    eq(
      'and free/busy reports each as a finite block',
      arr(obj(obj(obj(fb.body).calendars).primary).busy).map(
        (b) => `${String(obj(b).start)}/${String(obj(b).end)}`,
      ),
      [
        '2026-02-03T08:00:00.000Z/2026-02-03T08:30:00.000Z',
        '2026-02-03T10:00:00.000Z/2026-02-03T11:00:00.000Z',
        '2026-02-03T10:30:00.000Z/2026-02-03T11:00:00.000Z',
      ],
    )

    // ---- the cached tenant world, and the four ways it can go stale
    //
    // Every check above already rides the cache. What they cannot see is it
    // going WRONG, which needs the fake IN THIS PROCESS: what these assert is
    // what the cache HOLDS, and a request answers from the world in its own
    // hand either way.
    const rw = `${at}/_run/rw`
    check('run rw seeds', (await reset(rw, seed)) === 200)
    await post(`${rw}/v1/documents`, 't1', { title: 'before-reset' })
    // Door one: /reset replaces the rows with no route involved, which is
    // what `Fake.afterReset` exists for.
    check('resetting run rw again', (await reset(rw, seed)) === 200)
    eq('a scoped reset drops the cached world', await fileNames(rw, 't1'), ['Recall Survey'])

    const home = await start(gwsFake, 0)
    try {
      const at2 = home.endpoint
      check('the in-process fake seeds', (await reset(at2, seed)) === 200)
      const db = home.runtime.pool.client(DEFAULT_RUN)
      const T = DEFAULT_TENANT

      // Door two: a write handler that THROWS mutated in place and flushed
      // nothing. Asserted on the cache rather than a later response: the one
      // write route that can be made to throw from outside (`multipart/mixed`
      // with no boundary=) parses before it mints, so nothing observable
      // changes and a response-level check would pass either way.
      await api(`${at2}/drive/v3/files`, T)
      check('a read left a world cached', cachedState(db, T) !== undefined)
      const headless = Buffer.from(
        'From: a@example.com\r\nTo: b@example.com\r\nSubject: boom\r\n' +
          'Content-Type: multipart/mixed\r\n\r\nbody\r\n',
        'utf8',
      )
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      const boom = await post(`${at2}/gmail/v1/users/me/messages/send`, T, { raw: headless })
      check('a write route that throws is a 500', boom.status === 500, String(boom.status))
      check('and its half-applied world is evicted', cachedState(db, T) === undefined)

      // Door three: a read that missed can still be inside loadState when a
      // /reset drops the entry, or when a write that missed alongside it
      // flushes its own copy; see `Cached` in store/cache.ts.
      //
      // Driven by suspending a real load inside `withState`, because the
      // window needs a ~10ms load to outlive a ~100ms reset or write and a
      // race fired from a client would pass either way. The write arm goes
      // through the REAL write route, not the cache primitive under it.
      const stale = await loadState(db, T)
      dropState(db, T)
      const overtaken = await withState(db, T, async () => {
        await post(`${at2}/v1/documents`, T, { title: 'overtaking-write' })
        return stale
      })
      check('a load a write overtook still answers its own snapshot', overtaken === stale)
      check('but is not what stays cached', cachedState(db, T) !== stale)
      const named = await fileNames(at2, T)
      check(
        'and the write it was overtaken by survives',
        named.includes('overtaking-write'),
        named.join(','),
      )
      dropState(db, T)
      const dropped = await loadState(db, T)
      const raced = await withState(db, T, async () => {
        dropState(db, T)
        return dropped
      })
      check('a load a reset overtook answers its own snapshot too', raced === dropped)
      check('and leaves the cache empty rather than stale', cachedState(db, T) === undefined)
      // The positive control: every check above would also pass against a
      // `withState` that simply never installed anything.
      const fresh = await loadState(db, T)
      check(
        'while an uncontested load does install',
        (await withState(db, T, async () => fresh)) === fresh && cachedState(db, T) === fresh,
      )
    } finally {
      await home.close()
    }

    const bulk = await start(gwsFake, 0)
    try {
      await reset(bulk.endpoint, seed)
      const db = bulk.runtime.pool.client(DEFAULT_RUN)
      const st = await loadState(db, 't1')
      const file = createDriveItem(
        st,
        'large workbook',
        'application/vnd.google-apps.spreadsheet',
        [],
      )
      const tab = newTab(0, 'Data', 20_001, 1)
      const samples = ['', 'quote" and apostrophe\'', 'line\nfeed', '音楽', '\\', '\u0000']
      for (let row = 0; row < 20_001; row += 1)
        tab.cells.set(`${String(row)},0`, samples[row % samples.length] ?? '')
      tab.props.set('10000,0', { userEnteredFormat: { textFormat: { bold: true } } })
      tab.cells.delete('10001,0')
      tab.props.set('10001,0', { note: 'formatted, no value' })
      st.sheets.set(file.id, { title: file.name, tabs: [tab], nextSheetId: 1 })
      await saveState(db, gwsFake.dmmf, 't1', st)
      const restored = await loadState(db, 't1')
      check(
        'bulk cell persistence preserves text across chunk boundaries',
        isDeepStrictEqual(restored.sheets.get(file.id)?.tabs[0]?.cells, tab.cells),
      )
      check(
        'bulk cell persistence preserves formats, a formatted blank cell included',
        isDeepStrictEqual(restored.sheets.get(file.id)?.tabs[0]?.props, tab.props),
      )
      tab.cells.set('00,0', 'duplicate primary key')
      let refusal = ''
      try {
        await saveState(db, gwsFake.dmmf, 't1', st)
      } catch (err) {
        refusal = err instanceof Error ? err.message : String(err)
      }
      check(
        'an invalid bulk cell write fails on the composite key',
        refusal.includes('UNIQUE constraint failed'),
        refusal.replaceAll('\n', ' ').trim().slice(0, 160),
      )
      const rolledBack = await loadState(db, 't1')
      check(
        'a failed bulk write restores the entire previous workbook',
        isDeepStrictEqual(rolledBack.sheets, restored.sheets),
      )
    } finally {
      await bulk.close()
    }

    // Door four: keyed by the run's CLIENT, not its name, so two servers in
    // ONE process cannot reach each other's worlds. A map keyed by
    // `run|tenant` passes every other check here and fails this one.
    const a = await start(gwsFake, 0)
    const b = await start(gwsFake, 0)
    try {
      check('two in-process fakes seed the same run name', (await reset(a.endpoint, seed)) === 200)
      check('both of them', (await reset(b.endpoint, seed)) === 200)
      await post(`${a.endpoint}/v1/documents`, 't1', { title: 'only-in-a' })
      eq('a world belongs to one runtime', await fileNames(b.endpoint, 't1'), ['Recall Survey'])
      eq('and the other runtime kept its own', await fileNames(a.endpoint, 't1'), [
        'Recall Survey',
        'only-in-a',
      ])
    } finally {
      await a.close()
      await b.close()
    }

    // ---- a read route must never be the only place a counter moved
    check(
      'no read route dropped a clock or counter advance',
      !fake.stderr().includes('read route advanced'),
      fake.stderr().slice(0, 200),
    )
    process.stdout.write(`gws selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
