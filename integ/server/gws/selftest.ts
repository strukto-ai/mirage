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

import { parseDriveQuery, matchQuery } from './drive/query.ts'
import { createDriveItem } from './drive/item.ts'
import { GwsState } from './store/state.ts'
import { newTab, gridData } from './sheets/grid.ts'
import { sheetsBatchUpdate } from './sheets/batch.ts'
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
  check('direct Sheets sizes content', Number(tab.columnPixels?.[0]) > 100)
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
  check('direct Sheets exposes pixel metadata', arr(gridData(tab)[0]?.columnMetadata).length === 26)
  for (const failure of [
    { unsupported: {} },
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
  for (const [timeZone, dateTime, expected] of [
    ['Etc/GMT+12', '2026-09-25T20:59:00', '2026-09-25T20:59:00-12:00'],
    ['America/Los_Angeles', '2026-07-01T10:00:00', '2026-07-01T10:00:00-07:00'],
    ['America/Los_Angeles', '2026-01-01T10:00:00', '2026-01-01T10:00:00-08:00'],
    ['Asia/Kolkata', '2026-07-01T10:00:00.123', '2026-07-01T10:00:00.123+05:30'],
  ] as const) {
    const input = { timeZone, dateTime }
    const result = formatEventTime(input)
    eq('direct Calendar serializes a zoned instant', result.dateTime ?? '', expected ?? '')
    eq('direct Calendar preserves instant', slotMs(result, 'UTC'), slotMs(input, 'UTC'))
  }
  eq(
    'direct Calendar leaves all-day values alone',
    { ...formatEventTime({ date: '2026-07-01' }) },
    { date: '2026-07-01' },
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
  const expected = { dateTime: '2026-09-25T20:59:00-12:00', timeZone: 'Etc/GMT+12' }
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
}

async function main(): Promise<void> {
  compatibilityDirect()
  const fake = await launch()
  const at = fake.endpoint
  const seed = { tenants: ['t1'], epoch: EPOCH, extras: { forms: FORMS } }
  try {
    await compatibilityHttp(at)
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
      'Invalid format: "not-a-date"',
    )
    await refused(
      'a day February does not have is a 400',
      { dateTime: '2026-02-30T10:00:00Z' },
      { dateTime: '2026-02-30T11:00:00Z' },
      'Invalid format',
    )
    await refused(
      'an offset-free time with no zone is a 400',
      { dateTime: '2026-02-03T10:00:00' },
      { dateTime: '2026-02-03T11:00:00' },
      'Invalid format',
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
      'Invalid format',
    )
    await refused(
      'an all-day date the calendar does not have is a 400',
      { date: '2026-02-30' },
      { date: '2026-03-01' },
      'Invalid format',
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
    eq('and the stored event is unchanged', obj(kept.body).start ?? null, {
      dateTime: '2026-02-03T10:00:00Z',
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
