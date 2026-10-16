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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { ANNOUNCE_RE, start } from '../kit/typescript/index.ts'
import type { JsonValue } from '../kit/typescript/index.ts'
import { airtableFake } from './fake.ts'

// Every route the fake serves and every refusal it answers, against the v1
// fixture, each in its own run so no section sees another's writes. The error
// bodies are compared whole: a battery case prints them, and a reworded one is
// a behaviour change.

type Json = Record<string, JsonValue>

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')

const FULL = 'patIntegFullAccess.fake'
const ROADMAP_ONLY = 'patIntegRoadmapOnly.fake'
const ROADMAP = 'appRoadmapBase001'
const OPS = 'appOpsFinance0002'
const ARCHIVE = 'appArchive0000003'
const FEATURES = 'tblFeatures000001'
const RELEASES = 'tblReleases000002'
const ADA = 'usrAdaPark0000001'
const BEN = 'usrBenOrtiz000002'

const F = (n: number): string => `recFeat${String(n).padStart(10, '0')}`
const REL = (n: number): string => `recRel${String(n).padStart(11, '0')}`
const NEW = (kind: string, n: number): string => `${kind}New${String(n).padStart(11, '0')}`

const NOT_FOUND = { error: 'NOT_FOUND' }
const AUTH = { error: { type: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' } }
const MODEL = {
  error: {
    type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND',
    message:
      'Invalid permissions, or the requested model was not found. Check that both your user and your token have the required permissions, and that the model names and/or ids are correct.',
  },
}
const PERMISSION = {
  error: {
    type: 'INVALID_PERMISSIONS',
    message: 'You are not permitted to perform this operation',
  },
}
const INVALID = {
  error: {
    type: 'INVALID_REQUEST_UNKNOWN',
    message: 'Invalid request: parameter validation failed. Check your request data.',
  },
}
const BODY = { error: { type: 'INVALID_REQUEST_BODY', message: 'Could not parse request body' } }
const MISSING_ID = 'recZZZZZZZZZZZZZZ'
const ROW_MISSING = {
  error: {
    type: 'ROW_DOES_NOT_EXIST',
    message: `Record ID ${MISSING_ID} does not exist in this table`,
  },
}
const DELETE_MISSING = {
  error: { type: 'NOT_FOUND', message: `Could not find a record with ID "${MISSING_ID}".` },
}
const COMMENT_404 = { error: { type: 'MODEL_ID_NOT_FOUND', message: 'Comment not found' } }
const COMMENT_MISSING = { error: { type: 'ROW_COMMENT_DOES_NOT_EXIST' } }
const UPDATE_RECORDS = {
  error: {
    type: 'INVALID_RECORDS',
    message:
      'You must provide an array of up to 10 record objects, each with an "id" ID field and a "fields" object for cell values.',
  },
}
const CREATE_RECORDS = {
  error: {
    type: 'INVALID_RECORDS',
    message:
      'You must provide an array of up to 10 record objects, each with a "fields" object for cell values.',
  },
}
const DELETE_RECORDS = {
  error: { type: 'INVALID_RECORDS', message: 'You must provide an array of up to 10 record IDs.' },
}
const unknownField = (name: string): Json => ({
  error: { type: 'UNKNOWN_FIELD_NAME', message: `Unknown field name: "${name}"` },
})
const computed = (name: string): Json => ({
  error: {
    type: 'INVALID_VALUE_FOR_COLUMN',
    message: `Field "${name}" cannot accept a value because the field is computed`,
  },
})
const badValue = (name: string): Json => ({
  error: {
    type: 'INVALID_VALUE_FOR_COLUMN',
    message: `Field "${name}" cannot accept the provided value`,
  },
})
const badChoice = (v: string): Json => ({
  error: {
    type: 'INVALID_MULTIPLE_CHOICE_OPTIONS',
    message: `Insufficient permissions to create new select option "${JSON.stringify(v)}"`,
  },
})
const badOffset = (v: string): Json => ({
  error: { type: 'INVALID_OFFSET_VALUE', message: `The value of offset ${v} is invalid` },
})
const noView = (v: string): Json => ({
  error: { type: 'VIEW_NAME_NOT_FOUND', message: `View ${v} not found` },
})
const VIEW_ID_MISSING = {
  error: { type: 'VIEW_ID_NOT_FOUND', message: 'View viwZZZZZZZZZZZZZZ not found' },
}
const FOREIGN_VIEW = { error: { type: 'FAILED_STATE_CHECK' } }
const FORMULA_INVALID = {
  error: {
    type: 'INVALID_FILTER_BY_FORMULA',
    message:
      'The formula for filtering records is invalid: Invalid formula. Please check your formula text.',
  },
}
const formulaUnknown = (names: string): Json => ({
  error: {
    type: 'INVALID_FILTER_BY_FORMULA',
    message: `The formula for filtering records is invalid: Unknown field names: ${names}`,
  },
})

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(3, '0')} ${name}`
  process.stdout.write(detail === '' || ok ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`airtable selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue | undefined, want: JsonValue | undefined): void {
  const same = isDeepStrictEqual(got, want)
  check(name, same, same ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}

interface Res {
  status: number
  body: JsonValue
  type: string | null
}

interface Opts {
  method?: string
  token?: string | null
  auth?: string
  json?: JsonValue
  raw?: string
  contentType?: string
}

async function http(url: string, opts: Opts = {}): Promise<Res> {
  const headers: Record<string, string> = {}
  const token = opts.token === undefined ? FULL : opts.token
  if (token !== null) headers.Authorization = `Bearer ${token}`
  if (opts.auth !== undefined) headers.Authorization = opts.auth
  let body: string | undefined
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json)
    headers['Content-Type'] = 'application/json'
  } else if (opts.raw !== undefined) {
    body = opts.raw
    if (opts.contentType !== undefined) headers['Content-Type'] = opts.contentType
  }
  const r = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
  })
  const text = await r.text()
  return {
    status: r.status,
    body: text === '' ? null : (JSON.parse(text) as JsonValue),
    type: r.headers.get('content-type'),
  }
}

// Asserts status and body together, so a failure shows both.
async function expect(
  name: string,
  url: string,
  opts: Opts,
  status: number,
  want: JsonValue,
): Promise<void> {
  const r = await http(url, opts)
  eq(name, { status: r.status, body: r.body }, { status, body: want })
}

function obj(v: JsonValue | undefined): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new Error(`not an object: ${JSON.stringify(v)}`)
  return v
}

function list(v: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(v)) throw new Error(`not a list: ${JSON.stringify(v)}`)
  return v
}

function qs(params: Array<[string, string]>): string {
  return params.length === 0 ? '' : `?${new URLSearchParams(params).toString()}`
}

function ids(records: JsonValue[]): string[] {
  return records.map((r) => String(obj(r).id))
}

interface Pages {
  ids: string[]
  sizes: number[]
  records: Json[]
  lastOffset: JsonValue | undefined
}

// Follows `offset` to the end, re-sending the same parameters each time, as a
// client does.
async function listAll(
  url: string,
  params: Array<[string, string]> = [],
  token = FULL,
): Promise<Pages> {
  const out: Pages = { ids: [], sizes: [], records: [], lastOffset: undefined }
  let offset: string | undefined
  for (let guardPages = 0; guardPages < 50; guardPages += 1) {
    const page = await http(
      `${url}${qs(offset === undefined ? params : [...params, ['offset', offset]])}`,
      { token },
    )
    if (page.status !== 200)
      throw new Error(`list ${url} answered ${String(page.status)} ${JSON.stringify(page.body)}`)
    const body = obj(page.body)
    const records = list(body.records).map(obj)
    out.sizes.push(records.length)
    out.records.push(...records)
    out.ids.push(...ids(records))
    out.lastOffset = body.offset
    if (typeof body.offset !== 'string') return out
    offset = body.offset
  }
  throw new Error('pagination did not terminate')
}

async function reset(origin: string, run: string, body: JsonValue = {}): Promise<Res> {
  const r = await http(`${origin}/_run/${run}/reset`, { method: 'POST', json: body, token: null })
  if (r.status !== 200)
    throw new Error(`reset ${run}: ${String(r.status)} ${JSON.stringify(r.body)}`)
  return r
}

function fieldsOf(record: JsonValue | undefined): Json {
  return obj(obj(record).fields)
}

async function meta(origin: string): Promise<void> {
  const v0 = `${origin}/_run/meta/v0`
  await reset(origin, 'meta')
  await expect('whoami names the token owner', `${v0}/meta/whoami`, {}, 200, {
    id: ADA,
    email: 'ada@example.com',
  })
  await expect(
    'whoami for the restricted token',
    `${v0}/meta/whoami`,
    { token: ROADMAP_ONLY },
    200,
    {
      id: BEN,
      email: 'ben@example.com',
    },
  )
  await expect('no token is 401', `${v0}/meta/bases`, { token: null }, 401, AUTH)
  await expect('an unknown token is 401', `${v0}/meta/bases`, { token: 'patNope.fake' }, 401, AUTH)
  await expect('a Basic header is 401', `${v0}/meta/bases`, { auth: `Basic ${FULL}` }, 401, AUTH)
  await expect('list bases, full token', `${v0}/meta/bases`, {}, 200, {
    bases: [
      { id: ROADMAP, name: 'Product Roadmap', permissionLevel: 'create' },
      { id: OPS, name: 'Ops / Finance ✓', permissionLevel: 'edit' },
      { id: ARCHIVE, name: 'Archive', permissionLevel: 'read' },
    ],
  })
  await expect(
    'list bases, restricted token sees its grant only',
    `${v0}/meta/bases`,
    { token: ROADMAP_ONLY },
    200,
    {
      bases: [{ id: ROADMAP, name: 'Product Roadmap', permissionLevel: 'create' }],
    },
  )
  await expect(
    'a garbage bases offset is refused',
    `${v0}/meta/bases?offset=zzz`,
    {},
    422,
    badOffset('zzz'),
  )

  const r = await http(`${v0}/meta/bases`)
  eq('responses are json; charset=utf-8', r.type, 'application/json; charset=utf-8')

  const schema = obj((await http(`${v0}/meta/bases/${ROADMAP}/tables`)).body)
  const tables = list(schema.tables).map(obj)
  eq(
    'schema lists the tables in order',
    tables.map((t) => t.name ?? null),
    ['Features', 'Releases', 'Backlog'],
  )
  const features = tables[0] ?? {}
  eq(
    'a table renders id, name, description, primaryFieldId, fields, views',
    Object.keys(features),
    ['id', 'name', 'description', 'primaryFieldId', 'fields', 'views'],
  )
  eq('Features primary field', features.primaryFieldId, 'fldFeatName000001')
  const fields = list(features.fields).map(obj)
  eq(
    'Features field names, in order',
    fields.map((f) => f.name ?? null),
    [
      'Name',
      'Notes',
      'Status',
      'Tags',
      'Priority',
      'Shipped',
      'Due',
      'Kickoff',
      'Owner',
      'Release',
      'Mockups',
      'Ticket',
      'Created',
      'Number',
      'Release date',
      'Last modified',
    ],
  )
  eq('a field renders type and options ahead of id and name', Object.keys(fields[2] ?? {}), [
    'type',
    'options',
    'id',
    'name',
  ])
  eq('a field with a description and no options', fields[0], {
    id: 'fldFeatName000001',
    name: 'Name',
    type: 'singleLineText',
    description: 'Short feature title',
  })
  eq('a formula field carries its options', fields[11], {
    id: 'fldFeatTicket0012',
    name: 'Ticket',
    type: 'formula',
    options: {
      formula: '"FT-" & {fldFeatNumber0014}',
      isValid: true,
      referencedFieldIds: ['fldFeatNumber0014'],
      result: { type: 'singleLineText' },
    },
  })
  eq('views carry no visibleFieldIds unless asked', features.views, [
    { id: 'viwFeatGrid000001', name: 'Grid view', type: 'grid' },
    { id: 'viwFeatDone000002', name: 'Done', type: 'grid' },
    { id: 'viwFeatByOwner003', name: 'By owner / priority', type: 'kanban' },
  ])
  const withVisible = obj(
    (await http(`${v0}/meta/bases/${ROADMAP}/tables${qs([['include[]', 'visibleFieldIds']])}`))
      .body,
  )
  const views = list(obj(list(withVisible.tables)[0]).views).map(obj)
  eq('a grid view with no list shows every field', list(views[0]?.visibleFieldIds).length, 16)
  eq('a grid view lists its visible fields', views[1]?.visibleFieldIds, [
    'fldFeatName000001',
    'fldFeatStatus0003',
    'fldFeatPriority05',
    'fldFeatShipped006',
    'fldFeatOwner00009',
  ])
  eq('a kanban view never carries visibleFieldIds', views[2]?.visibleFieldIds, undefined)
  await expect(
    'include takes only visibleFieldIds',
    `${v0}/meta/bases/${ROADMAP}/tables?include[]=x`,
    {},
    422,
    INVALID,
  )
  await expect(
    'a malformed base id is 404 before auth',
    `${v0}/meta/bases/appShort/tables`,
    { token: null },
    404,
    NOT_FOUND,
  )
  await expect(
    'an unknown base is 403',
    `${v0}/meta/bases/appZZZZZZZZZZZZZZ/tables`,
    {},
    403,
    MODEL,
  )
  await expect(
    'an ungranted base is the same 403',
    `${v0}/meta/bases/${OPS}/tables`,
    { token: ROADMAP_ONLY },
    403,
    MODEL,
  )
  const ops = obj((await http(`${v0}/meta/bases/${OPS}/tables`)).body)
  eq(
    'a table name may hold a slash',
    list(ops.tables).map((t) => obj(t).name ?? null),
    ['Q3 / Budget'],
  )
}

async function reads(origin: string): Promise<void> {
  const v0 = `${origin}/_run/reads/v0`
  const features = `${v0}/${ROADMAP}/${FEATURES}`
  await reset(origin, 'reads')
  const all = await listAll(features)
  eq(
    'with no view, records come in record-id order, paged by the fixture pageCap',
    all.ids,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(F),
  )
  eq('pageCap 4 splits ten records 4/4/2', all.sizes, [4, 4, 2])
  eq('the last page carries no offset', all.lastOffset, undefined)
  const first = obj((await http(features)).body)
  check(
    'a page offset is itr<14>/rec<14>',
    /^itr[0-9A-Za-z]{14}\/rec[0-9A-Za-z]{14}$/.test(String(first.offset)),
  )
  const byName = await listAll(`${v0}/${ROADMAP}/Features`)
  eq('a table is reachable by name', byName.ids, all.ids)
  const lower = await listAll(`${v0}/${ROADMAP}/features`)
  eq('a table name matches in any case', lower.ids, all.ids)
  const backlog = await listAll(`${v0}/${ROADMAP}/Backlog`)
  eq('Backlog holds 25 records over seven pages', backlog.sizes, [4, 4, 4, 4, 4, 4, 1])
  const capped = await listAll(`${v0}/${ROADMAP}/Backlog`, [['maxRecords', '21']])
  eq('maxRecords caps the total across pages', capped.sizes, [4, 4, 4, 4, 4, 1])
  eq('no offset once maxRecords is reached', capped.lastOffset, undefined)
  const three = obj((await http(`${v0}/${ROADMAP}/Backlog${qs([['maxRecords', '3']])}`)).body)
  eq('maxRecords below a page', [list(three.records).length, three.offset ?? null], [3, null])
  const small = await listAll(features, [['pageSize', '3']])
  eq('pageSize below the cap', small.sizes, [3, 3, 3, 1])
  for (const bad of ['0', '101', 'x', '2.5']) {
    await expect(`pageSize=${bad} is refused`, `${features}?pageSize=${bad}`, {}, 422, INVALID)
  }
  await expect('maxRecords=0 is refused', `${features}?maxRecords=0`, {}, 422, INVALID)
  await expect('a garbage offset is refused', `${features}?offset=nope`, {}, 422, badOffset('nope'))
  await expect(
    'an offset of the wrong kind is refused',
    `${features}${qs([['offset', 'itr00000000000004/appRoadmapBase001']])}`,
    {},
    422,
    badOffset('itr00000000000004/appRoadmapBase001'),
  )
  await expect('cellFormat=string is refused', `${features}?cellFormat=string`, {}, 422, INVALID)
  await expect('an unknown parameter is refused', `${features}?colour=red`, {}, 422, INVALID)
  await expect('an unknown table name is 403', `${v0}/${ROADMAP}/Nope`, {}, 403, MODEL)
  await expect('an unknown table id is 403', `${v0}/${ROADMAP}/tblZZZZZZZZZZZZZZ`, {}, 403, MODEL)
  await expect(
    'a malformed base id is 404 before auth',
    `${v0}/appShort/Features`,
    { token: null },
    404,
    NOT_FOUND,
  )
  await expect(
    'an ungranted base is 403 for records too',
    `${v0}/${OPS}/Q3 %2F Budget`,
    { token: ROADMAP_ONLY },
    403,
    MODEL,
  )

  const done = await listAll(features, [['view', 'Done']])
  eq('a view filters and sorts (Status = Done, Priority desc, ties by order)', done.ids, [
    F(1),
    F(8),
    F(7),
    F(3),
  ])
  eq(
    'a view is reachable by id',
    (await listAll(features, [['view', 'viwFeatDone000002']])).ids,
    done.ids,
  )
  const kanban = await listAll(features, [['view', 'By owner / priority']])
  eq('a two-key view sort, empty owners first', kanban.ids, [5, 9, 1, 8, 4, 6, 2, 10, 7, 3].map(F))
  await expect('an unknown view is refused', `${features}?view=Nope`, {}, 422, noView('Nope'))
  await expect(
    'an unknown view id is refused as an id',
    `${features}?view=viwZZZZZZZZZZZZZZ`,
    {},
    422,
    VIEW_ID_MISSING,
  )
  await expect(
    "another table's view id fails the state check",
    `${features}?view=viwRelGrid0000001`,
    {},
    422,
    FOREIGN_VIEW,
  )
  const resorted = await listAll(features, [
    ['view', 'Done'],
    ['sort[0][field]', 'Name'],
  ])
  eq('sort overrides the view order but keeps its filter', resorted.ids, [F(3), F(1), F(7), F(8)])
  const priority = await listAll(features, [
    ['sort[0][field]', 'Priority'],
    ['sort[0][direction]', 'desc'],
  ])
  eq('sort desc puts empty cells last', priority.ids, [1, 8, 4, 6, 2, 7, 3, 10, 5, 9].map(F))
  const status = await listAll(features, [['sort[0][field]', 'fldFeatStatus0003']])
  eq(
    'a select sorts by option order, empty first',
    status.ids,
    [9, 4, 5, 10, 2, 6, 1, 3, 7, 8].map(F),
  )
  await expect(
    'a sort on an unknown field is refused',
    `${features}${qs([['sort[0][field]', 'Nope']])}`,
    {},
    422,
    unknownField('Nope'),
  )
  await expect(
    'a sort direction outside asc/desc is refused',
    `${features}${qs([
      ['sort[0][field]', 'Name'],
      ['sort[0][direction]', 'up'],
    ])}`,
    {},
    422,
    INVALID,
  )

  const two = obj(
    (
      await http(
        `${features}${qs([
          ['fields[]', 'Name'],
          ['fields[]', 'fldFeatPriority05'],
          ['maxRecords', '2'],
        ])}`,
      )
    ).body,
  )
  eq('fields[] by name and id', list(two.records).map(fieldsOf), [
    { Name: 'Full-text search', Priority: 5 },
    { Name: 'CSV export', Priority: 3 },
  ])
  const plain = obj(
    (
      await http(
        `${features}${qs([
          ['fields', 'Name'],
          ['maxRecords', '1'],
        ])}`,
      )
    ).body,
  )
  eq('a bare repeated fields= works too', list(plain.records).map(fieldsOf), [
    { Name: 'Full-text search' },
  ])
  await expect(
    'fields[] naming nothing is refused',
    `${features}${qs([['fields[]', 'Nope']])}`,
    {},
    422,
    unknownField('Nope'),
  )
  const byId = await listAll(features, [
    ['returnFieldsByFieldId', 'true'],
    ['maxRecords', '5'],
  ])
  eq('returnFieldsByFieldId keys cells by field id', Object.keys(fieldsOf(byId.records[4])), [
    'fldFeatName000001',
    'fldFeatStatus0003',
    'fldFeatPriority05',
    'fldFeatTicket0012',
    'fldFeatCreated013',
    'fldFeatNumber0014',
    'fldFeatModified16',
  ])

  const rec = (id: string): Json => all.records.find((r) => r.id === id) ?? {}
  eq('a full record, every cell type', rec(F(1)), {
    id: F(1),
    createdTime: '2026-04-01T09:00:00.000Z',
    fields: {
      Name: 'Full-text search',
      Notes: 'Index every mounted table.\nExpose it through grep.',
      Status: 'Done',
      Tags: ['backend', 'infra'],
      Priority: 5,
      Shipped: true,
      Due: '2026-06-15',
      Kickoff: '2026-05-04T09:30:00.000Z',
      Owner: { id: ADA, email: 'ada@example.com', name: 'Ada Park' },
      Release: [REL(1)],
      Mockups: [
        {
          id: 'attSearchWire0001',
          url: 'https://v5.airtableusercontent.invalid/v3/u/attSearchWire0001/search-wireframe.png',
          filename: 'search-wireframe.png',
          size: 48213,
          type: 'image/png',
          width: 1280,
          height: 800,
          thumbnails: {
            small: {
              url: 'https://v5.airtableusercontent.invalid/v3/u/attSearchWire0001/thumb-small.png',
              width: 58,
              height: 36,
            },
            large: {
              url: 'https://v5.airtableusercontent.invalid/v3/u/attSearchWire0001/thumb-large.png',
              width: 819,
              height: 512,
            },
            full: {
              url: 'https://v5.airtableusercontent.invalid/v3/u/attSearchWire0001/thumb-full.png',
              width: 1280,
              height: 800,
            },
          },
        },
      ],
      Ticket: 'FT-1',
      Created: '2026-04-01T09:00:00.000Z',
      Number: 1,
      'Release date': ['2026-06-01'],
      'Last modified': '2026-06-15T16:45:00.000Z',
    },
  })
  eq('empty cells are omitted (no Notes, Tags, Owner, Release, Release date)', rec(F(5)), {
    id: F(5),
    createdTime: '2026-04-05T09:00:00.000Z',
    fields: {
      Name: 'Offline mode',
      Status: 'Todo',
      Priority: 1,
      Ticket: 'FT-5',
      Created: '2026-04-05T09:00:00.000Z',
      Number: 5,
      'Last modified': '2026-04-05T09:00:00.000Z',
    },
  })
  eq('an unchecked checkbox is omitted, not false', fieldsOf(rec(F(8))).Shipped, undefined)
  eq('a lookup of an empty date is omitted', fieldsOf(rec(F(4)))['Release date'], undefined)
  eq('a record with no Status or Priority', Object.keys(fieldsOf(rec(F(9)))), [
    'Name',
    'Notes',
    'Tags',
    'Ticket',
    'Created',
    'Number',
    'Last modified',
  ])
  const releases = await listAll(`${v0}/${ROADMAP}/${RELEASES}`)
  eq(
    'counts derive from the link; the rollup is the fixture value',
    releases.records.map((r) => [
      fieldsOf(r).Name ?? null,
      fieldsOf(r)['Feature count'] ?? null,
      fieldsOf(r)['Total priority'] ?? null,
    ]),
    [
      ['v1.0', 3, 10],
      ['v1.1', 3, 12],
      ['v2.0', 2, 6],
    ],
  )
  eq('the inverse link side', fieldsOf(releases.records[0]).Features, [F(1), F(3), F(7)])

  const withCounts = await listAll(features, [['recordMetadata[]', 'commentCount']])
  eq(
    'commentCount appears only where there are comments',
    withCounts.records
      .filter((r) => r.commentCount !== undefined)
      .map((r) => [r.id ?? null, r.commentCount ?? null]),
    [
      [F(1), 5],
      [F(3), 2],
    ],
  )
  eq('commentCount follows fields in key order', Object.keys(withCounts.records[0] ?? {}), [
    'id',
    'createdTime',
    'fields',
    'commentCount',
  ])
  await expect(
    'recordMetadata takes only commentCount',
    `${features}?recordMetadata[]=x`,
    {},
    422,
    INVALID,
  )

  const budget = await listAll(`${v0}/${OPS}/${encodeURIComponent('Q3 / Budget')}`)
  eq(
    'a slash in a table name, url-encoded',
    budget.records.map((r) => fieldsOf(r)),
    [
      { Item: 'Cloud hosting', Amount: 12500.5, Share: 0.42, Approved: true },
      { Item: 'Contractors', Amount: 8000, Share: 0.27 },
      { Item: 'Conferences', Amount: 2250.75, Share: 0.075, Approved: true },
      { Item: 'Café ☕ & snacks', Amount: 310.2, Share: 0.235 },
    ],
  )
  const archive = await listAll(`${v0}/${ARCHIVE}/Old Projects`)
  eq('the archive base reads', archive.ids, [
    'recOld00000000001',
    'recOld00000000002',
    'recOld00000000003',
  ])
}

async function formulas(origin: string): Promise<void> {
  const v0 = `${origin}/_run/formulas/v0`
  const features = `${v0}/${ROADMAP}/${FEATURES}`
  await reset(origin, 'formulas')
  const cases: Array<[string, number[]]> = [
    ['{Name} = "CSV export"', [2]],
    ["{Status} = 'Done'", [1, 3, 7, 8]],
    ["{Status} != 'Done'", [2, 4, 5, 6, 9, 10]],
    ['{Shipped}', [1, 3, 7]],
    ['NOT({Shipped})', [2, 4, 5, 6, 8, 9, 10]],
    ['{Shipped} = TRUE()', [1, 3, 7]],
    ['{Shipped} = FALSE()', [2, 4, 5, 6, 8, 9, 10]],
    ['{Priority} = 5', [1, 8]],
    ['{Priority} >= 4', [1, 4, 6, 8]],
    ['Priority = 4', [4, 6]],
    ["OR({Priority} = 5, {Status} = 'Todo')", [1, 4, 5, 8, 10]],
    ["AND(SEARCH('o', {Name}), {Priority} >= 3)", [2, 4, 6, 7]],
    ["RECORD_ID() = 'recFeat0000000004'", [4]],
    ["FIND('mode', {Name})", [3, 5]],
    ["FIND('Mode', {Name})", []],
    ["SEARCH('MODE', {Name})", [3, 5]],
    ["LOWER({Name}) = 'csv export'", [2]],
    ["{Owner} = 'Ada Park'", [1, 4, 8]],
    ["{Tags} = 'backend, infra'", [1, 4]],
    ["{Release} = 'v1.0'", [1, 3, 7]],
    ["SEARCH('2026-06', {Release date})", [1, 3, 7]],
    ["{Due} = '2026-06-15T00:00:00.000Z'", [1]],
    ["{Due} = '2026-06-15'", []],
    ["FIND('T00:00:00.000Z', {Due} & '')", [1, 2, 3, 4, 7]],
    ["{Ticket} = 'FT-3'", [3]],
    ["{Status} = ''", [9]],
    ['{Notes}', [1, 2, 4, 6, 8, 9, 10]],
    ['IF({Shipped}, 1, 0)', [1, 3, 7]],
    ['IF({Priority} = 3, 1, 0)', [2, 7]],
    ['{Name} = "" & IF({Priority} = 3, {Name}, "___") & ""', [2, 7]],
    ['IF({Priority} = 3, IF({Shipped}, 0, 1), 0)', [2]],
    ['SWITCH({Priority}, 3, 1, 5, 1, 0)', [1, 2, 7, 8]],
    ['SWITCH({Priority}, 3, 1)', [2, 7]],
    ['{Priority} * 2', [1, 2, 3, 4, 5, 6, 7, 8, 10]],
    ['{Priority} * 2 = 6', [2, 7]],
    ['{Priority} + 1 = 6', [1, 8]],
    ['{Priority} - 1 = 2', [2, 7]],
    ['{Priority} / 2 = 1.5', [2, 7]],
    ['{Priority} + 2 * 3 = 9', [2, 7]],
    ['({Priority} + 2) * 3 = 15', [2, 7]],
    ['"P" & {Priority} + 1 = "P4"', [2, 7]],
    ['-{Priority} * -2 = 6', [2, 7]],
    ['MID({Name}, 1, 3) = "CSV"', [2]],
    ['LEFT({Name}, 3) = "CSV"', [2]],
    ['RIGHT({Name}, 4) = "mode"', [3, 5]],
    ['TRIM(" " & {Name} & " ") = "CSV export"', [2]],
    ['SUBSTITUTE({Name}, "export", "import") = "CSV import"', [2]],
    ['CONCATENATE(LEFT({Name}, 3), ":", {Priority}) = "CSV:3"', [2]],
    ['VALUE(RIGHT({Ticket}, 1)) = 3', [3]],
    ['{Due} & "" = "2026-07-01T00:00:00.000Z"', [2]],
    ['MONTH({Due}) = 7', [2]],
    ['YEAR({Due}) & "-" & MONTH({Due}) & "-" & DAY({Due}) = "2026-7-1"', [2]],
    ['DATETIME_FORMAT({Due}, "YYYY-MM-DD") = "2026-07-01"', [2]],
    ['IS_SAME({Due}, "2026-07-01T23:59:59Z", "day")', [2]],
    ['IS_SAME({Due}, "2026-07-25", "month")', [2]],
    ['IS_SAME({Due}, "2026-07-01")', [2]],
    ['if({fldFeatPriority05} = 3, left({Name}, 3) = "CSV", FALSE())', [2]],
    ['1 / 0', []],
    ['"x" & (1 / 0)', []],
    ['IF({Due}, MONTH({Due}) = 7, FALSE())', [2]],
  ]
  for (const [formula, want] of cases) {
    const got = await listAll(features, [['filterByFormula', formula]])
    eq(`filterByFormula ${formula}`, got.ids, want.map(F))
  }
  const withView = await listAll(features, [
    ['view', 'Done'],
    ['filterByFormula', 'IF({Priority} * 2 = 10, TRUE(), FALSE())'],
  ])
  eq('a formula narrows a view', withView.ids, [F(1), F(8)])
  eq(
    'an empty formula filters nothing',
    (await listAll(features, [['filterByFormula', '']])).ids.length,
    10,
  )
  const refused: Array<[string, Json]> = [
    ['{Nope} = 1', formulaUnknown('Nope')],
    ['AND({Nope}, {Zip})', formulaUnknown('Nope, Zip')],
    ['IF(TRUE(), 1, {Nope} + {Zip})', formulaUnknown('Nope, Zip')],
    ['SWITCH(1, 1, 2, {Nope})', formulaUnknown('Nope')],
    ['IF({Shipped})', FORMULA_INVALID],
    ['IF({Shipped}, 1, 0, 2)', FORMULA_INVALID],
    ['SWITCH({Priority}, 1)', FORMULA_INVALID],
    ['{Priority} *', FORMULA_INVALID],
    ['{Priority} ** 2', FORMULA_INVALID],
    ['LEFT({Name})', FORMULA_INVALID],
    ['MID({Name}, 1)', FORMULA_INVALID],
    ['SUBSTITUTE({Name}, "x")', FORMULA_INVALID],
    ['YEAR()', FORMULA_INVALID],
    ['DATETIME_FORMAT({Due})', FORMULA_INVALID],
    ['IS_SAME({Due})', FORMULA_INVALID],
    ['UNKNOWN_FUNCTION({Name})', FORMULA_INVALID],
    ['{Status} = ', FORMULA_INVALID],
    ['NOT()', FORMULA_INVALID],
    ["'unterminated", FORMULA_INVALID],
  ]
  for (const [formula, want] of refused) {
    await expect(
      `filterByFormula ${formula} is refused`,
      `${features}${qs([['filterByFormula', formula]])}`,
      {},
      422,
      want,
    )
  }

  const post = await http(`${features}/listRecords`, {
    method: 'POST',
    json: {
      view: 'Done',
      fields: ['Name'],
      filterByFormula: 'IF({Priority} + 1 = 6, TRUE(), FALSE())',
      returnFieldsByFieldId: true,
    },
  })
  eq('POST listRecords takes the parameters in the body', post.body, {
    records: [
      {
        id: F(1),
        createdTime: '2026-04-01T09:00:00.000Z',
        fields: { fldFeatName000001: 'Full-text search' },
      },
      {
        id: F(8),
        createdTime: '2026-04-08T09:00:00.000Z',
        fields: { fldFeatName000001: 'Rate limiter' },
      },
    ],
  })
  const sorted = obj(
    (
      await http(`${features}/listRecords`, {
        method: 'POST',
        json: { sort: [{ field: 'Priority', direction: 'desc' }], maxRecords: 3, fields: ['Name'] },
      })
    ).body,
  )
  eq('POST listRecords sorts and caps', ids(list(sorted.records)), [F(1), F(8), F(4)])
  const keepsView = obj(
    (await http(`${features}/listRecords`, { method: 'POST', json: { view: 'Done', sort: [] } }))
      .body,
  )
  eq('an empty sort keeps the view order', ids(list(keepsView.records)), [F(1), F(8), F(7), F(3)])
  await expect(
    'POST listRecords refuses an unknown key',
    `${features}/listRecords`,
    { method: 'POST', json: { colour: 1 } },
    422,
    INVALID,
  )
  await expect(
    'POST listRecords refuses a bad type',
    `${features}/listRecords`,
    { method: 'POST', json: { pageSize: '3' } },
    422,
    INVALID,
  )
  await expect(
    'malformed JSON is INVALID_REQUEST_BODY',
    `${features}/listRecords`,
    { method: 'POST', raw: '{"view": ', contentType: 'application/json' },
    422,
    BODY,
  )
  await expect(
    'a body not sent as JSON is INVALID_REQUEST_BODY',
    `${features}/listRecords`,
    { method: 'POST', raw: '{}', contentType: 'text/plain' },
    422,
    BODY,
  )
}

async function formulaFields(): Promise<void> {
  const nan = { specialValue: 'NaN' }
  const cases: Array<[string, JsonValue | undefined]> = [
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['20 / 2 / 5', 2],
    ['10 - 3 - 2', 5],
    ['2 * -3 + 10 / (3 - 1)', -1],
    ['--2', 2],
    ['.5 + 2.5', 3],
    ['"P" & 2 + 3 * 4 & "!"', 'P14!'],
    ['BLANK() + 2', 2],
    ['TRUE() + 2', 3],
    ['"3" * 2', 6],
    ['"no number" + 1', nan],
    ['1 / 0', nan],
    ['0 / 0', nan],
    ['"x" & (1 / 0)', nan],
    ['IF(1 / 0 = 1 / 0, 1, 0)', nan],
    ['IF(TRUE(), 7, 1 / 0)', 7],
    ['IF(FALSE(), 1 / 0, "ok")', 'ok'],
    ['IF(FALSE(), "unused")', undefined],
    ['IF(ERROR(), 1, 2)', nan],
    ['IF(ISERROR(1 / 0), "caught", "missed")', 'caught'],
    ['AND(FALSE(), ERROR())', nan],
    ['OR(TRUE(), ERROR())', nan],
    ['SWITCH(2, 1, ERROR(), 2, "two", ERROR())', 'two'],
    ['SWITCH(9, 1, "one", 2, "two", "other")', 'other'],
    ['SWITCH(9, 1, "one", 2, "two")', undefined],
    ['SWITCH(1, "1", "same")', 'same'],
    ['SWITCH(ERROR(), 1, "one", "other")', nan],
    ['LEFT("A😀BC", 2)', 'A😀'],
    ['RIGHT("A😀BC", 3)', '😀BC'],
    ['MID("A😀BC", 2, 2)', '😀B'],
    ['LEFT("abc", 0)', undefined],
    ['RIGHT("abc", 0)', undefined],
    ['MID("abc", 9, 2)', undefined],
    ['RIGHT("abc", 99)', 'abc'],
    ['LEFT("abc", -1)', nan],
    ['MID("abc", 0, 1)', nan],
    ['LEFT("abc", "bad")', nan],
    ['LEFT(BLANK(), 3)', undefined],
    ['LEFT(1234, 2)', '12'],
    ['TRIM("  a  b  ")', 'a  b'],
    ['SUBSTITUTE("gold mold", "old", "et")', 'get met'],
    ['SUBSTITUTE("gold mold", "old", "et", 2)', 'gold met'],
    ['SUBSTITUTE("gold mold", "old", "et", 9)', 'gold mold'],
    ['SUBSTITUTE("a.a.a", ".", "$&", 2)', 'a.a$&a'],
    ['SUBSTITUTE("aaa", "aa", "x")', 'xa'],
    ['SUBSTITUTE("abc", "", "x")', 'abc'],
    ['SUBSTITUTE("abc", "a", "x", 0)', nan],
    ['CONCATENATE("x", 3, TRUE(), BLANK())', 'x31'],
    ['CONCATENATE("x", ERROR())', nan],
    ['VALUE("$1,234.50")', 1234.5],
    ['VALUE(" -12.5 ")', -12.5],
    ['VALUE("1e2")', 100],
    ['VALUE("abc")', nan],
    ['VALUE("")', nan],
    ['YEAR("2026-01-01T00:30:00+02:00")', 2025],
    ['MONTH("2026-01-01T00:30:00+02:00")', 12],
    ['DAY("2026-01-01T00:30:00+02:00")', 31],
    ['YEAR("2024-02-29")', 2024],
    ['DAY("2025-02-29")', nan],
    ['YEAR(BLANK())', nan],
    ['MONTH("not a date")', nan],
    ['YEAR(2026)', nan],
    ['HOUR("2026-07-01T12:34:56Z")', 12],
    ['MINUTE("2026-07-01T12:34:56Z")', 34],
    ['SECOND("2026-07-01T12:34:56Z")', 56],
    ['DATETIME_FORMAT("07/10/19", "YYYY-MM-DD")', '2019-07-10'],
    ['DATETIME_FORMAT("4 Mar 2017 7:00", "YYYY-MM-DD HH:mm")', '2017-03-04 07:00'],
    [
      'DATETIME_FORMAT("2026-07-01T12:34:56.789Z", "dddd, MMMM Do YYYY [at] h:mm:ss.SSS A Z")',
      'Wednesday, July 1st 2026 at 12:34:56.789 PM +00:00',
    ],
    ['DATETIME_FORMAT("2026-07-01", "L [week] W [quarter] Q")', '07/01/2026 week 27 quarter 3'],
    ['DATETIME_FORMAT("2026-01-01T00:30:00+02:00", "YYYY-MM-DD HH:mm")', '2025-12-31 22:30'],
    ['DATETIME_FORMAT(BLANK(), "YYYY")', nan],
    ['DATETIME_FORMAT("bad", "YYYY")', nan],
    ['IF(IS_SAME("2026-07-01", "2026-07-31", "months"), 1, 0)', 1],
    ['IF(IS_SAME("2026-07-01", "2025-07-01", "month"), 1, 0)', 0],
    ['IF(IS_SAME("2026-07-01", "2026-08-01", "quarter"), 1, 0)', 1],
    ['IF(IS_SAME("2026-07-01", "2026-07-01T23:59:00Z", "days"), 1, 0)', 1],
    ['IF(IS_SAME("2026-07-01", "2026-07-02", "day"), 1, 0)', 0],
    ['IF(IS_SAME("2026-07-01T00:00:00.100Z", "2026-07-01T00:00:00.900Z"), 1, 0)', 1],
    ['IF(IS_SAME("2026-07-01T00:00:00.100Z", "2026-07-01T00:00:01Z"), 1, 0)', 0],
    ['IF(IS_SAME("2026-01-01T00:30:00+02:00", "2025-12-31", "day"), 1, 0)', 1],
    ['IS_SAME(BLANK(), "2026-07-01")', nan],
    ['IS_SAME("2026-07-01", "2026-07-01", "no-unit")', nan],
  ]
  const fixture = obj(
    JSON.parse(await readFile(join(INTEG, 'fixtures/airtable/v1.json'), 'utf8')) as JsonValue,
  )
  const base = obj(list(fixture.bases).find((b) => obj(b).id === ROADMAP))
  const table = obj(list(base.tables).find((t) => obj(t).id === FEATURES))
  table.fields = [
    ...list(table.fields),
    ...cases.map(([formula], i) => ({
      id: `fldFormula${String(i).padStart(7, '0')}`,
      name: `Formula ${String(i)}`,
      type: 'formula',
      options: { formula },
    })),
    {
      id: 'fldCalculated0001',
      name: 'Calculated',
      type: 'formula',
      options: {
        formula:
          'IF({Due}, CONCATENATE(LEFT({Name}, 3), ":", DATETIME_FORMAT({Due}, "YYYY-MM-DD"), ":", {Priority} * 2), BLANK())',
      },
    },
    {
      id: 'fldDueYear0000001',
      name: 'Due year',
      type: 'formula',
      options: { formula: 'DATETIME_FORMAT({Due}, "YYYY")' },
    },
    {
      id: 'fldDueLabel000001',
      name: 'Due label',
      type: 'formula',
      options: { formula: 'IF(ISERROR({Due year}), "no date", "due " & {Due year})' },
    },
  ]
  table.views = [
    {
      id: 'viwFormula0000001',
      name: 'Formula view',
      type: 'grid',
      filter: 'IF(IS_SAME({Due}, "2026-07-01", "month"), {Priority} * 2 = 6, FALSE())',
    },
  ]
  const root = await mkdtemp(join(tmpdir(), 'airtable-formulas-'))
  try {
    await mkdir(join(root, 'airtable'))
    await writeFile(join(root, 'airtable/formulas.json'), JSON.stringify(fixture))
    const fake = await start(airtableFake, 0, 'formulas', root)
    try {
      const features = `${fake.endpoint}/v0/${ROADMAP}/${FEATURES}`
      const first = await http(`${features}/${F(1)}`)
      eq('computed formula fields are readable', first.status, 200)
      for (const [i, [formula, want]] of cases.entries()) {
        eq(`formula field ${formula}`, fieldsOf(first.body)[`Formula ${String(i)}`], want)
      }
      eq(
        'a view uses conditional, date and arithmetic expressions',
        (await listAll(features, [['view', 'Formula view']])).ids,
        [F(2)],
      )
      const filtered = await listAll(features, [
        ['filterByFormula', '{Calculated} = "CSV:2026-07-01:6"'],
      ])
      eq('filters read derived formula fields', filtered.ids, [F(2)])
      eq(
        'derived text and date formatting',
        fieldsOf(filtered.records[0]).Calculated,
        'CSV:2026-07-01:6',
      )
      const undated = fieldsOf((await http(`${features}/${F(5)}`)).body)
      eq('a formula field in error renders as one', undated['Due year'], nan)
      eq('ISERROR sees a referenced formula error', undated['Due label'], 'no date')
      eq('a referenced formula value passes through', fieldsOf(first.body)['Due label'], 'due 2026')
      eq(
        'filters see a referenced formula error',
        (await listAll(features, [['filterByFormula', 'ISERROR({Due year})']])).ids,
        [5, 6, 8, 9, 10].map(F),
      )
      eq(
        'operators carry a referenced formula error',
        (await listAll(features, [['filterByFormula', '{Due year} & "" = ""']])).ids,
        [],
      )
      const changed = await http(`${features}/${F(2)}`, {
        method: 'PATCH',
        json: { fields: { Priority: 4 } },
      })
      eq(
        'formula fields recompute on writes',
        fieldsOf(changed.body).Calculated,
        'CSV:2026-07-01:8',
      )
      eq(
        'view formulas recompute on writes',
        (await listAll(features, [['view', 'Formula view']])).ids,
        [],
      )
    } finally {
      await fake.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function single(origin: string): Promise<void> {
  const v0 = `${origin}/_run/single/v0`
  await reset(origin, 'single')
  const one = await http(`${v0}/${ROADMAP}/Features/${F(3)}`)
  eq(
    'get a record',
    [one.status, Object.keys(obj(one.body)), fieldsOf(one.body).Name ?? null],
    [200, ['id', 'createdTime', 'fields'], 'Dark mode'],
  )
  const byId = await http(`${v0}/${ROADMAP}/Features/${F(3)}?returnFieldsByFieldId=true`)
  eq('get a record keyed by field id', fieldsOf(byId.body).fldFeatName000001, 'Dark mode')
  await expect(
    'a well-formed missing record is the 403 an ungranted one gets',
    `${v0}/${ROADMAP}/Features/recZZZZZZZZZZZZZZ`,
    {},
    403,
    MODEL,
  )
  await expect(
    'a malformed record id is 404 NOT_FOUND before auth',
    `${v0}/${ROADMAP}/Features/recShort`,
    { token: null },
    404,
    NOT_FOUND,
  )
  const other = await http(`${v0}/${ROADMAP}/Features/${REL(1)}`)
  eq(
    'a record of another table is found base-wide',
    [
      other.status,
      fieldsOf(other.body).Name ?? null,
      fieldsOf(other.body)['Feature count'] ?? null,
    ],
    [200, 'v1.0', 3],
  )
  await expect(
    'get record refuses an unknown parameter',
    `${v0}/${ROADMAP}/Features/${F(3)}?view=Done`,
    {},
    422,
    INVALID,
  )
  await expect('unknown table beats a real record', `${v0}/${ROADMAP}/Nope/${F(3)}`, {}, 403, MODEL)
}

async function writes(origin: string): Promise<void> {
  const EPOCH = '2026-09-01T00:00:00.000Z'
  const at = (n: number): string => new Date(Date.parse(EPOCH) + n * 1000).toISOString()
  const v0 = `${origin}/_run/writes/v0`
  const features = `${v0}/${ROADMAP}/${FEATURES}`
  const post = (json: JsonValue, url = features): Promise<Res> =>
    http(url, { method: 'POST', json })
  const patch = (json: JsonValue, url = features): Promise<Res> =>
    http(url, { method: 'PATCH', json })
  const put = (json: JsonValue, url = features): Promise<Res> => http(url, { method: 'PUT', json })
  const get = async (id: string, table = FEATURES): Promise<Json> =>
    fieldsOf((await http(`${v0}/${ROADMAP}/${table}/${id}`)).body)
  await reset(origin, 'writes', { epoch: EPOCH })

  const created = await post({
    fields: { Name: 'Webhooks', Status: 'Todo', Priority: 2, Tags: ['backend'] },
  })
  eq('create one record: minted id, run clock, next autoNumber, derived cells', created.body, {
    id: NEW('rec', 1),
    createdTime: at(1),
    fields: {
      Name: 'Webhooks',
      Status: 'Todo',
      Tags: ['backend'],
      Priority: 2,
      Ticket: 'FT-11',
      Created: at(1),
      Number: 11,
      'Last modified': at(1),
    },
  })
  const pair = await post({
    records: [{ fields: { Name: 'Alpha' } }, { fields: { Name: 'Beta', Shipped: true } }],
  })
  eq(
    'create a batch: one timestamp, consecutive numbers',
    list(obj(pair.body).records).map((r) => [
      obj(r).id ?? null,
      obj(r).createdTime ?? null,
      fieldsOf(r).Number ?? null,
    ]),
    [
      [NEW('rec', 2), at(2), 12],
      [NEW('rec', 3), at(2), 13],
    ],
  )
  const eleven = Array.from({ length: 11 }, (_, i) => ({ fields: { Name: `n${String(i)}` } }))
  await expect(
    'eleven records is over the batch limit',
    features,
    { method: 'POST', json: { records: eleven } },
    422,
    CREATE_RECORDS,
  )
  await expect(
    'an empty batch is refused',
    features,
    { method: 'POST', json: { records: [] } },
    422,
    CREATE_RECORDS,
  )
  await expect(
    'a body with neither records nor fields',
    features,
    { method: 'POST', json: {} },
    422,
    CREATE_RECORDS,
  )
  await expect(
    'a create record may carry only fields',
    features,
    { method: 'POST', json: { records: [{ id: F(1), fields: {} }] } },
    422,
    CREATE_RECORDS,
  )
  await expect(
    'an unknown body key is refused',
    features,
    { method: 'POST', json: { fields: {}, colour: 1 } },
    422,
    INVALID,
  )
  for (const name of ['Ticket', 'Created', 'Number', 'Release date', 'Last modified']) {
    await expect(
      `writing computed ${name} is refused`,
      features,
      { method: 'POST', json: { fields: { [name]: 'x' } } },
      422,
      computed(name),
    )
  }
  await expect(
    'an unknown field is refused',
    features,
    { method: 'POST', json: { fields: { Nope: 1 } } },
    422,
    unknownField('Nope'),
  )
  await expect(
    'a text for a number',
    features,
    { method: 'POST', json: { fields: { Priority: 'high' } } },
    422,
    badValue('Priority'),
  )
  await expect(
    'a string for a checkbox',
    features,
    { method: 'POST', json: { fields: { Shipped: 'yes' } } },
    422,
    badValue('Shipped'),
  )
  await expect(
    'a non-date for a date',
    features,
    { method: 'POST', json: { fields: { Due: 'tomorrow' } } },
    422,
    badValue('Due'),
  )
  await expect(
    'a link to a missing record',
    features,
    { method: 'POST', json: { fields: { Release: ['recZZZZZZZZZZZZZZ'] } } },
    422,
    badValue('Release'),
  )
  await expect(
    'an unknown collaborator',
    features,
    { method: 'POST', json: { fields: { Owner: { id: 'usrZZZZZZZZZZZZZZ' } } } },
    422,
    badValue('Owner'),
  )
  await expect(
    'an unknown select option without typecast',
    features,
    { method: 'POST', json: { fields: { Status: 'Blocked' } } },
    422,
    badChoice('Blocked'),
  )
  await expect(
    'an unknown multi-select option without typecast',
    features,
    { method: 'POST', json: { fields: { Tags: ['backend', 'ops'] } } },
    422,
    badChoice('ops'),
  )
  const cast = await post({
    fields: { Name: 'Gamma', Status: 'Blocked', Priority: '3' },
    typecast: true,
  })
  eq(
    'typecast adds the option and converts the number; refusals burned no id',
    [
      obj(cast.body).id ?? null,
      fieldsOf(cast.body).Status ?? null,
      fieldsOf(cast.body).Priority ?? null,
    ],
    [NEW('rec', 4), 'Blocked', 3],
  )
  const schema = obj((await http(`${v0}/meta/bases/${ROADMAP}/tables`)).body)
  const status = obj(list(obj(list(schema.tables)[0]).fields)[2])
  eq(
    'the new option is in the schema',
    list(obj(status.options).choices).map((c) => obj(c).name ?? null),
    ['Todo', 'In progress', 'Done', 'Blocked'],
  )
  eq('with a minted id', obj(list(obj(status.options).choices)[3]).id, NEW('sel', 1))

  const patched = await patch({ records: [{ id: F(2), fields: { Priority: 1 } }] })
  eq(
    'PATCH updates what it names and moves Last modified',
    list(obj(patched.body).records)
      .map(fieldsOf)
      .map((f) => [f.Priority ?? null, f.Notes ?? null, f['Last modified'] ?? null]),
    [[1, 'Weekly export of the metrics board.', at(4)]],
  )
  await expect(
    'PATCH over the batch limit',
    features,
    { method: 'PATCH', json: { records: eleven.map((r) => ({ id: F(1), ...r })) } },
    422,
    UPDATE_RECORDS,
  )
  await expect(
    'PATCH without an id',
    features,
    { method: 'PATCH', json: { records: [{ fields: { Priority: 1 } }] } },
    422,
    UPDATE_RECORDS,
  )
  await expect(
    'PATCH with a malformed id',
    features,
    { method: 'PATCH', json: { records: [{ id: 'bogus', fields: {} }] } },
    422,
    UPDATE_RECORDS,
  )
  await expect(
    'PATCH with no records',
    features,
    { method: 'PATCH', json: {} },
    422,
    UPDATE_RECORDS,
  )
  await expect(
    'PATCH a missing record',
    features,
    { method: 'PATCH', json: { records: [{ id: 'recZZZZZZZZZZZZZZ', fields: {} }] } },
    422,
    ROW_MISSING,
  )
  await expect(
    'PATCH a computed field',
    features,
    { method: 'PATCH', json: { records: [{ id: F(2), fields: { Ticket: 'x' } }] } },
    422,
    computed('Ticket'),
  )

  const replaced = await put({ records: [{ id: F(5), fields: { Name: 'Offline mode v2' } }] })
  eq(
    'PUT clears every writable field it leaves out',
    fieldsOf(list(obj(replaced.body).records)[0]),
    {
      Name: 'Offline mode v2',
      Ticket: 'FT-5',
      Created: '2026-04-05T09:00:00.000Z',
      Number: 5,
      'Last modified': at(5),
    },
  )

  await patch({ records: [{ id: F(5), fields: { Release: [REL(2)] } }] })
  eq('linking fills the lookup', (await get(F(5)))['Release date'], ['2026-07-15'])
  eq(
    'and the inverse side, and its count',
    [
      (await get(REL(2), RELEASES)).Features ?? null,
      (await get(REL(2), RELEASES))['Feature count'] ?? null,
    ],
    [[F(2), F(6), F(8), F(5)], 4],
  )
  await patch(
    { records: [{ id: REL(1), fields: { Features: [F(1), F(3)] } }] },
    `${v0}/${ROADMAP}/${RELEASES}`,
  )
  const seven = await get(F(7))
  eq(
    'unlinking from the other side clears this side and moves its Last modified',
    [seven.Release ?? null, seven['Release date'] ?? null, seven['Last modified'] ?? null],
    [null, null, at(7)],
  )

  const upsert = await patch({
    performUpsert: { fieldsToMergeOn: ['Name'] },
    records: [
      { fields: { Name: 'CSV export', Priority: 2 } },
      { fields: { Name: 'Search v2', Priority: 4 } },
      { id: F(6), fields: { Priority: 5 } },
    ],
  })
  const up = obj(upsert.body)
  eq(
    'upsert: one match updates, none creates, an id is a plain update',
    [up.updatedRecords ?? null, up.createdRecords ?? null],
    [[F(2), F(6)], [NEW('rec', 5)]],
  )
  eq(
    'upsert renders in request order',
    list(up.records).map((r) => [obj(r).id ?? null, fieldsOf(r).Priority ?? null]),
    [
      [F(2), 2],
      [NEW('rec', 5), 4],
      [F(6), 5],
    ],
  )
  await post({ records: [{ fields: { Name: 'Twin' } }, { fields: { Name: 'Twin' } }] })
  await expect(
    'upsert refuses more than one match',
    features,
    {
      method: 'PATCH',
      json: {
        performUpsert: { fieldsToMergeOn: ['Name'] },
        records: [{ fields: { Name: 'Twin' } }],
      },
    },
    422,
    {
      error: {
        type: 'INVALID_RECORDS',
        message:
          'More than one existing record matches the fieldsToMergeOn values of a record in the request',
      },
    },
  )
  await expect(
    'upsert refuses a computed merge field',
    features,
    {
      method: 'PATCH',
      json: {
        performUpsert: { fieldsToMergeOn: ['Ticket'] },
        records: [{ fields: { Name: 'x' } }],
      },
    },
    422,
    INVALID,
  )
  await expect(
    'upsert refuses an unknown merge field',
    features,
    {
      method: 'PATCH',
      json: { performUpsert: { fieldsToMergeOn: ['Nope'] }, records: [{ fields: { Name: 'x' } }] },
    },
    422,
    unknownField('Nope'),
  )
  await expect(
    'upsert needs one to three merge fields',
    features,
    {
      method: 'PATCH',
      json: { performUpsert: { fieldsToMergeOn: [] }, records: [{ fields: {} }] },
    },
    422,
    INVALID,
  )

  const one = await patch({ fields: { Notes: 'Weekly and monthly.' } }, `${features}/${F(2)}`)
  eq(
    'single-record PATCH',
    [
      obj(one.body).id ?? null,
      fieldsOf(one.body).Notes ?? null,
      fieldsOf(one.body).Priority ?? null,
    ],
    [F(2), 'Weekly and monthly.', 2],
  )
  const whole = await put({ fields: { Name: 'Mobile app', Status: 'Todo' } }, `${features}/${F(9)}`)
  eq(
    'single-record PUT is destructive',
    [
      fieldsOf(whole.body).Notes ?? null,
      fieldsOf(whole.body).Tags ?? null,
      fieldsOf(whole.body).Status ?? null,
    ],
    [null, null, 'Todo'],
  )
  await expect(
    'single-record PATCH needs fields',
    `${features}/${F(2)}`,
    { method: 'PATCH', json: {} },
    422,
    INVALID,
  )
  await expect(
    'single-record PATCH of a missing record',
    `${features}/recZZZZZZZZZZZZZZ`,
    { method: 'PATCH', json: { fields: {} } },
    403,
    MODEL,
  )
  await expect('single-record DELETE', `${features}/${F(10)}`, { method: 'DELETE' }, 200, {
    id: F(10),
    deleted: true,
  })
  await expect('a deleted record is gone', `${features}/${F(10)}`, {}, 403, MODEL)
  eq('and gone from the other side of its link', (await get(REL(3), RELEASES)).Features, [F(4)])

  await expect(
    'DELETE a batch',
    `${features}${qs([
      ['records[]', NEW('rec', 2)],
      ['records[]', NEW('rec', 3)],
    ])}`,
    { method: 'DELETE' },
    200,
    {
      records: [
        { id: NEW('rec', 2), deleted: true },
        { id: NEW('rec', 3), deleted: true },
      ],
    },
  )
  await expect('DELETE with no ids', features, { method: 'DELETE' }, 422, DELETE_RECORDS)
  await expect(
    'DELETE over the batch limit',
    `${features}${qs(Array.from({ length: 11 }, (_, i): [string, string] => ['records[]', F(i + 1)]))}`,
    { method: 'DELETE' },
    422,
    DELETE_RECORDS,
  )
  await expect(
    'DELETE a malformed id',
    `${features}?records[]=bogus`,
    { method: 'DELETE' },
    422,
    DELETE_RECORDS,
  )
  await expect(
    'DELETE a missing id',
    `${features}?records[]=recZZZZZZZZZZZZZZ`,
    { method: 'DELETE' },
    404,
    DELETE_MISSING,
  )
  await expect(
    'delete the record with comments',
    `${features}/${F(1)}`,
    { method: 'DELETE' },
    200,
    { id: F(1), deleted: true },
  )
  await expect('its comments went with it', `${features}/${F(1)}/comments`, {}, 403, MODEL)
  eq('and its link', (await get(REL(1), RELEASES)).Features, [F(3)])

  const after = await listAll(features)
  eq('the table after every write, in seq order', after.ids, [
    F(2),
    F(3),
    F(4),
    F(5),
    F(6),
    F(7),
    F(8),
    F(9),
    NEW('rec', 1),
    NEW('rec', 4),
    NEW('rec', 5),
    NEW('rec', 6),
    NEW('rec', 7),
  ])
  await expect(
    'malformed JSON on a write',
    features,
    { method: 'POST', raw: '{"fields":', contentType: 'application/json' },
    422,
    BODY,
  )
  await expect(
    'a read-only base refuses writes',
    `${v0}/${ARCHIVE}/Old Projects`,
    { method: 'POST', json: { fields: { Name: 'x' } } },
    403,
    PERMISSION,
  )
  await expect(
    'the restricted token cannot write outside its grant',
    `${v0}/${OPS}/${encodeURIComponent('Q3 / Budget')}`,
    { method: 'POST', json: { fields: { Item: 'x' } }, token: ROADMAP_ONLY },
    403,
    MODEL,
  )
  const budget = await http(`${v0}/${OPS}/${encodeURIComponent('Q3 / Budget')}`, {
    method: 'POST',
    json: { fields: { Item: 'Travel', Amount: 99.5, Share: 0.01 } },
  })
  eq('an editor base takes writes', fieldsOf(budget.body), {
    Item: 'Travel',
    Amount: 99.5,
    Share: 0.01,
  })
}

async function comments(origin: string): Promise<void> {
  const EPOCH = '2026-10-01T00:00:00.000Z'
  const at = (n: number): string => new Date(Date.parse(EPOCH) + n * 1000).toISOString()
  const v0 = `${origin}/_run/comments/v0`
  const on = (n: number): string => `${v0}/${ROADMAP}/${FEATURES}/${F(n)}/comments`
  await reset(origin, 'comments', { epoch: EPOCH })
  const page1 = obj((await http(on(1))).body)
  eq(
    'comments list newest first, one pageCap at a time',
    ids(list(page1.comments)),
    [5, 4, 3, 2].map((n) => `comFeat01Note000${String(n)}`),
  )
  check('a comment offset is handed out', typeof page1.offset === 'string')
  const page2 = obj((await http(`${on(1)}${qs([['offset', String(page1.offset)]])}`)).body)
  eq(
    'the last page says offset null',
    [ids(list(page2.comments)), 'offset' in page2 ? page2.offset : 'absent'],
    [['comFeat01Note0001'], null],
  )
  eq('a comment renders author, text and both times', list(page1.comments)[0], {
    id: 'comFeat01Note0005',
    author: { id: BEN, email: 'ben@example.com', name: 'Ben Ortiz' },
    text: 'Verified ✓',
    createdTime: '2026-06-14T10:00:00.000Z',
    lastUpdatedTime: '2026-06-14T11:30:00.000Z',
  })
  eq('a mention is expanded', obj(list(page1.comments)[1]).mentioned, {
    [BEN]: { type: 'user', id: BEN, displayName: 'Ben Ortiz', email: 'ben@example.com' },
  })
  const three = obj((await http(on(3))).body)
  eq(
    'one page with offset null, a threaded reply first',
    [
      ids(list(three.comments)),
      obj(list(three.comments)[0]).parentCommentId ?? null,
      'offset' in three ? three.offset : 'absent',
    ],
    [['comFeat03Note0002', 'comFeat03Note0001'], 'comFeat03Note0001', null],
  )
  eq('no comments is an empty page with offset null', (await http(on(2))).body, {
    comments: [],
    offset: null,
  })
  const small = obj((await http(`${on(1)}?pageSize=2`)).body)
  eq('pageSize applies to comments', list(small.comments).length, 2)
  await expect('comment pageSize is validated', `${on(1)}?pageSize=0`, {}, 422, INVALID)
  await expect('a garbage comment offset', `${on(1)}?offset=x`, {}, 422, badOffset('x'))
  await expect(
    'comments of a missing record',
    `${v0}/${ROADMAP}/${FEATURES}/recZZZZZZZZZZZZZZ/comments`,
    {},
    403,
    MODEL,
  )

  const made = await http(on(3), { method: 'POST', json: { text: 'Ship it' } })
  eq('create a comment', made.body, {
    id: NEW('com', 1),
    author: { id: ADA, email: 'ada@example.com', name: 'Ada Park' },
    text: 'Ship it',
    createdTime: at(1),
    lastUpdatedTime: null,
  })
  eq('it lists first', ids(list(obj((await http(on(3))).body).comments))[0], NEW('com', 1))
  await expect(
    'an empty comment is refused',
    on(3),
    { method: 'POST', json: { text: '' } },
    422,
    INVALID,
  )
  await expect(
    'an unknown comment key is refused',
    on(3),
    { method: 'POST', json: { text: 'x', colour: 1 } },
    422,
    INVALID,
  )
  await expect(
    'a reply to a missing comment',
    on(3),
    { method: 'POST', json: { text: 'x', parentCommentId: 'comZZZZZZZZZZZZZZ' } },
    404,
    COMMENT_404,
  )
  const edited = await http(`${on(3)}/${NEW('com', 1)}`, {
    method: 'PATCH',
    json: { text: 'Shipped' },
  })
  eq(
    'edit your own comment',
    [obj(edited.body).text ?? null, obj(edited.body).lastUpdatedTime ?? null],
    ['Shipped', at(2)],
  )
  await expect(
    "editing someone else's comment is refused",
    `${on(1)}/comFeat01Note0002`,
    { method: 'PATCH', json: { text: 'x' } },
    403,
    PERMISSION,
  )
  const bens = await http(`${on(1)}/comFeat01Note0002`, {
    method: 'PATCH',
    json: { text: 'Grep push-down, please.' },
    token: ROADMAP_ONLY,
  })
  eq(
    'its author may edit it',
    [bens.status, obj(bens.body).text ?? null],
    [200, 'Grep push-down, please.'],
  )
  await expect(
    'a malformed comment id is 404 NOT_FOUND',
    `${on(1)}/comShort`,
    { method: 'PATCH', json: { text: 'x' } },
    404,
    NOT_FOUND,
  )
  await expect(
    'an edit of a missing comment names it',
    `${on(1)}/comZZZZZZZZZZZZZZ`,
    { method: 'PATCH', json: { text: 'x' } },
    422,
    {
      error: {
        type: 'ROW_COMMENT_DOES_NOT_EXIST',
        message: 'Row comment with id comZZZZZZZZZZZZZZ does not exist',
      },
    },
  )
  await expect(
    'a delete of a missing comment answers the type alone',
    `${on(1)}/comZZZZZZZZZZZZZZ`,
    { method: 'DELETE' },
    422,
    COMMENT_MISSING,
  )
  await expect('delete your own comment', `${on(3)}/${NEW('com', 1)}`, { method: 'DELETE' }, 200, {
    id: NEW('com', 1),
    deleted: true,
  })
  eq('it is gone', ids(list(obj((await http(on(3))).body).comments)), [
    'comFeat03Note0002',
    'comFeat03Note0001',
  ])
  await expect(
    'a read-only base refuses comments',
    `${v0}/${ARCHIVE}/Old Projects/recOld00000000001/comments`,
    { method: 'POST', json: { text: 'x' } },
    403,
    PERMISSION,
  )
}

// A webhook sees every record write on its base from its creation on, one
// payload per write, numbered from cursor 1; the fake never notifies.
async function webhooks(origin: string): Promise<void> {
  const EPOCH = '2026-10-01T00:00:00.000Z'
  const at = (n: number): string => new Date(Date.parse(EPOCH) + n * 1000).toISOString()
  const v0 = `${origin}/_run/webhooks/v0`
  const hooks = `${v0}/bases/${ROADMAP}/webhooks`
  const features = `${v0}/${ROADMAP}/${FEATURES}`
  const spec = { options: { filters: { dataTypes: ['tableData'] } } }
  await reset(origin, 'webhooks', { epoch: EPOCH })
  await expect('a base has no webhooks at first', hooks, {}, 200, { webhooks: [] })
  await expect(
    'a webhook needs a specification',
    hooks,
    { method: 'POST', json: { notificationUrl: 'https://example.com/ping' } },
    422,
    INVALID,
  )
  const hook = NEW('ach', 1)
  const expires = new Date(Date.parse(at(1)) + 7 * 24 * 3600 * 1000).toISOString()
  await expect(
    'create a webhook: minted id, seven days to live',
    hooks,
    { method: 'POST', json: { notificationUrl: 'https://example.com/ping', specification: spec } },
    200,
    { id: hook, macSecretBase64: Buffer.from(hook).toString('base64'), expirationTime: expires },
  )
  await expect('it lists with its next cursor', hooks, {}, 200, {
    webhooks: [
      {
        id: hook,
        areNotificationsEnabled: true,
        cursorForNextPayload: 1,
        lastNotificationResult: null,
        notificationUrl: 'https://example.com/ping',
        isHookEnabled: true,
        lastSuccessfulNotificationTime: null,
        expirationTime: expires,
        specification: spec,
      },
    ],
  })
  const payloads = `${hooks}/${hook}/payloads`
  await expect('no write, no payload', payloads, {}, 200, {
    payloads: [],
    cursor: 1,
    mightHaveMore: false,
  })
  await http(`${features}/${F(1)}`, { method: 'PATCH', json: { fields: { Priority: 5 } } })
  await expect('a write that changes nothing is no payload', payloads, {}, 200, {
    payloads: [],
    cursor: 1,
    mightHaveMore: false,
  })
  await http(`${features}/${F(1)}`, { method: 'PATCH', json: { fields: { Priority: 4 } } })
  const first = obj((await http(payloads)).body)
  const one = obj(list(first.payloads)[0])
  eq(
    'a write is one payload naming the records it changed',
    [
      first.cursor ?? null,
      first.mightHaveMore ?? null,
      list(first.payloads).length,
      one.timestamp ?? null,
    ],
    [2, false, 1, at(3)],
  )
  eq(
    'the payload is v0, numbered by the base, keyed by table and record',
    [
      one.payloadFormat ?? null,
      one.baseTransactionNumber ?? null,
      Object.keys(obj(obj(obj(one.changedTablesById)[FEATURES]).changedRecordsById)),
    ],
    ['v0', 1, [F(1)]],
  )
  const made = obj(
    (await http(features, { method: 'POST', json: { fields: { Name: 'Hook' } } })).body,
  )
  await http(`${features}/${String(made.id)}`, { method: 'DELETE' })
  const next = obj((await http(`${payloads}?cursor=2`)).body)
  eq(
    'a create and a delete follow from the cursor',
    [
      next.cursor ?? null,
      list(next.payloads).map((p) => Object.keys(obj(obj(obj(p).changedTablesById)[FEATURES]))),
    ],
    [4, [['createdRecordsById'], ['destroyedRecordIds']]],
  )
  const paged = obj((await http(`${payloads}?limit=1`)).body)
  eq(
    'limit pages them',
    [list(paged.payloads).length, paged.cursor ?? null, paged.mightHaveMore ?? null],
    [1, 2, true],
  )
  await expect('limit is at most 50', `${payloads}?limit=51`, {}, 422, INVALID)
  await expect('a cursor counts from 1', `${payloads}?cursor=0`, {}, 422, INVALID)
  await expect('an unknown query key is refused', `${payloads}?since=1`, {}, 422, INVALID)
  await expect('an unknown webhook', `${hooks}/achZZZZZZZZZZZZZZ/payloads`, {}, 404, NOT_FOUND)
  await expect(
    "a webhook is its own base's",
    `${v0}/bases/${OPS}/webhooks/${hook}/payloads`,
    {},
    404,
    NOT_FOUND,
  )
  await expect(
    'a base the token cannot see',
    `${v0}/bases/${OPS}/webhooks`,
    { token: ROADMAP_ONLY },
    403,
    MODEL,
  )
  await expect('delete a webhook', `${hooks}/${hook}`, { method: 'DELETE' }, 200, {})
  await expect('it is gone with its payloads', hooks, {}, 200, { webhooks: [] })
  await expect('its payloads go with it', payloads, {}, 404, NOT_FOUND)
}

async function isolation(origin: string): Promise<void> {
  const features = (run: string): string => `${origin}/_run/${run}/v0/${ROADMAP}/${FEATURES}`
  await reset(origin, 'iso-a')
  await reset(origin, 'iso-b')
  const made = await http(features('iso-a'), {
    method: 'POST',
    json: { fields: { Name: 'Only in A' } },
  })
  const id = String(obj(made.body).id)
  eq('the write landed in its run', (await listAll(features('iso-a'))).ids.length, 11)
  eq('another run never sees it', (await listAll(features('iso-b'))).ids.length, 10)
  await expect('not even by id', `${features('iso-b')}/${id}`, {}, 403, MODEL)
  eq(
    'nor does the bare origin',
    (await listAll(`${origin}/v0/${ROADMAP}/${FEATURES}`)).ids.length,
    10,
  )
  await reset(origin, 'iso-a')
  eq('a reset puts the run back', (await listAll(features('iso-a'))).ids.length, 10)
  await expect(
    'a run nobody reset answers 401, even to a good token',
    `${origin}/_run/never-seeded/v0/meta/bases`,
    {},
    401,
    AUTH,
  )
  await reset(origin, 'cap1', { extras: { pageCap: 1 } })
  eq(
    'extras.pageCap overrides the fixture for one reset',
    (await listAll(features('cap1'))).sizes,
    Array.from({ length: 10 }, () => 1),
  )
  const refused = await http(`${origin}/_run/cap2/reset`, {
    method: 'POST',
    json: { extras: { colour: 1 } },
    token: null,
  })
  eq('an unknown extras key is a 400', refused.status, 400)
}

async function routes(origin: string): Promise<void> {
  const v0 = `${origin}/_run/routes/v0`
  await reset(origin, 'routes')
  const unrouted: Array<[string, string]> = [
    ['GET', `${v0}/${ROADMAP}`],
    ['GET', `${origin}/v1/meta/bases`],
    ['DELETE', `${v0}/meta/bases`],
    ['GET', `${v0}/${ROADMAP}/Features/${F(1)}/records`],
    ['POST', `${v0}/${ROADMAP}/Features/${F(1)}`],
    ['GET', `${v0}/meta/bases/${ROADMAP}`],
  ]
  for (const [method, url] of unrouted) {
    await expect(
      `${method} ${url.replace(origin, '')} is 404 NOT_FOUND`,
      url,
      { method, token: null },
      404,
      NOT_FOUND,
    )
  }
  const r = await http(`${v0}/nope`, { token: null })
  eq('a 404 is json too', r.type, 'application/json; charset=utf-8')
}

async function announce(): Promise<void> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0'],
    {
      cwd: INTEG,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  try {
    const first = await new Promise<string>((ok, bad) => {
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        out += d
        const nl = out.indexOf('\n')
        if (nl !== -1) ok(out.slice(0, nl))
      })
      child.on('exit', (code) => {
        bad(new Error(`main.ts exited ${String(code)} before announcing\n${err}`))
      })
    })
    check(
      'main.ts announces AIRTABLE_URL',
      ANNOUNCE_RE.test(first) && first.startsWith('AIRTABLE_URL='),
      first,
    )
    const url = first.split('=').slice(1).join('=')
    const r = await http(`${url}/v0/meta/bases`)
    eq('the standalone fake serves the fixture at once', list(obj(r.body).bases).length, 3)
  } finally {
    child.kill('SIGTERM')
  }
}

const fake = await start(airtableFake, 0)
try {
  await meta(fake.endpoint)
  await reads(fake.endpoint)
  await formulas(fake.endpoint)
  await single(fake.endpoint)
  await writes(fake.endpoint)
  await comments(fake.endpoint)
  await webhooks(fake.endpoint)
  await isolation(fake.endpoint)
  await routes(fake.endpoint)
} finally {
  await fake.close()
}
await announce()
await formulaFields()
process.stdout.write(`airtable selftest: ${String(checks)} checks passed\n`)
