import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_RE } from '../kit/typescript/announce.ts'
import type { JsonValue } from '../kit/typescript/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const TENANT = 'selftest-notion'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`notion selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue | undefined, want: JsonValue): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? '' : `got ${a} want ${b}`)
}

interface Fake {
  child: ChildProcessByStdio<null, Readable, Readable>
  endpoint: string
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
  return { child, endpoint: first.split('=').slice(1).join('=') }
}

const PAGE = 'aaaa1111-2222-3333-4444-555566667777'

function paragraph(content: string): JsonValue {
  return { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content } }] } }
}

async function request(
  at: string,
  method: string,
  path: string,
  body?: JsonValue,
  status = 200,
  version = '2025-09-03',
): Promise<Record<string, JsonValue>> {
  const response = await fetch(at + path, {
    method,
    headers: {
      Authorization: `Bearer ${TENANT}`,
      'Notion-Version': version,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value = (await response.json()) as Record<string, JsonValue>
  eq(`${method} ${path} status`, response.status, status)
  if (status === 400) {
    eq(
      'validation error envelope',
      [value.object ?? null, value.status ?? null, value.code ?? null],
      ['error', 400, 'validation_error'],
    )
  }
  return value
}

function results(body: Record<string, JsonValue>): Record<string, JsonValue>[] {
  return body.results as Record<string, JsonValue>[]
}

const DB = 'eeee1111-2222-3333-4444-555566667777'
const DS = 'd5000000-2222-3333-4444-555566667777'
const BOT = 'e0000000-0000-4000-8000-000000000001'

function titles(body: Record<string, JsonValue>): string[] {
  return results(body).map((row) => {
    const name = (row.properties as Record<string, Record<string, JsonValue>>).Name
    return String((name?.title as Record<string, JsonValue>[])[0]?.plain_text)
  })
}

// The reads this fake used to answer unlike live Notion, on the v1 fixture with
// one more dated row: users, date filters and sorts, filter_properties, a
// search with no object filter, the 2022-06-28 shapes and id cursors. The
// MCP-Atlas replay (notion_atlas.ts) pins the same behaviour against recorded
// live replies; these pin it where no recording reaches.
async function liveReads(at: string): Promise<void> {
  await request(at, 'POST', '/reset', { tenants: [TENANT], fixture: 'v1' })
  const users = await request(at, 'GET', '/v1/users')
  eq(
    'users list, integration last',
    results(users).map((user) => user.id!),
    ['user-1', 'user-2', BOT],
  )
  eq('users list envelope', [users.type!, users.user!], ['user', {}])
  const first = await request(at, 'GET', '/v1/users?page_size=1')
  eq('users cursor is the next id', first.next_cursor, 'user-2')
  eq(
    'users resume from an id',
    results(await request(at, 'GET', '/v1/users?start_cursor=user-2')).map((user) => user.id!),
    ['user-2', BOT],
  )
  const refused = await request(at, 'GET', '/v1/users?start_cursor=nope', undefined, 400)
  eq('unknown cursor refused', refused.message, 'The start_cursor provided is invalid: nope')
  eq('user by id', (await request(at, 'GET', '/v1/users/user-1')).name, 'Integ Author')
  eq('integration by id', (await request(at, 'GET', `/v1/users/${BOT}`)).type, 'bot')
  await request(at, 'GET', '/v1/users/nope', undefined, 404)

  const created = await request(at, 'POST', '/v1/pages', {
    parent: { data_source_id: DS },
    properties: {
      Name: { title: [{ text: { content: 'Kickoff' } }] },
      Due: { date: { start: '2026-01-15' } },
    },
  })
  eq(
    'created row carries every column in schema order',
    Object.keys(created.properties as Record<string, JsonValue>),
    ['Name', 'Priority', 'Done', 'Stage', 'Tags', 'Due', 'Link', 'Notes'],
  )
  eq(
    'unset columns are empty',
    ['Priority', 'Done', 'Stage', 'Tags', 'Link', 'Notes'].map((name) => {
      const prop = (created.properties as Record<string, Record<string, JsonValue>>)[name]!
      return prop[String(prop.type)]!
    }),
    [null, false, null, [], null, []],
  )
  const query = (body: JsonValue, tail = '', version = '2025-09-03', status = 200) =>
    request(at, 'POST', `/v1/data_sources/${DS}/query${tail}`, body, status, version)
  const due = (cond: JsonValue): JsonValue => ({ filter: { property: 'Due', date: cond } })
  eq('date before', titles(await query(due({ before: '2026-01-01' }))), [])
  eq('date equals', titles(await query(due({ equals: '2026-02-01' }))), ['Write spec'])
  eq('date on_or_after', titles(await query(due({ on_or_after: '2026-01-15' }))), [
    'Write spec',
    'Kickoff',
  ])
  eq('date after an instant', titles(await query(due({ after: '2026-01-15T12:00:00.000Z' }))), [
    'Write spec',
  ])
  eq('date is_empty', titles(await query(due({ is_empty: true }))), ['Ship beta'])
  await query(due({ past_week: {} }), '', '2025-09-03', 400)
  eq(
    'date sort ascending, undated last',
    titles(await query({ sorts: [{ property: 'Due', direction: 'ascending' }] })),
    ['Kickoff', 'Write spec', 'Ship beta'],
  )
  eq(
    'date sort descending, undated last',
    titles(await query({ sorts: [{ property: 'du', direction: 'descending' }] })),
    ['Write spec', 'Kickoff', 'Ship beta'],
  )
  eq(
    'filter_properties keeps the asked columns in the asked order',
    results(await query({}, '?filter_properties=pri&filter_properties=Name')).map((row) =>
      Object.keys(row.properties as Record<string, JsonValue>),
    ),
    [
      ['Priority', 'Name'],
      ['Priority', 'Name'],
      ['Priority', 'Name'],
    ],
  )
  for (const tail of [
    '?filter_properties[]=pri&filter_properties[]=Name',
    '?filter_properties=pri&filter_properties%5B%5D=Name',
  ]) {
    for (const [path, version] of [
      [`/v1/data_sources/${DS}/query`, '2025-09-03'],
      [`/v1/databases/${DB}/query`, '2022-06-28'],
    ]) {
      const filtered = await request(at, 'POST', `${path}${tail}`, {}, 200, version)
      eq(
        'bracket property filters match repeated keys',
        results(filtered).map((row) => Object.keys(row.properties as Record<string, JsonValue>)),
        [
          ['Priority', 'Name'],
          ['Priority', 'Name'],
          ['Priority', 'Name'],
        ],
      )
    }
  }
  const page = await query({ page_size: 1 })
  eq('query cursor is the next row', page.next_cursor, 'ffff2222-3333-4444-5555-666677778888')
  eq(
    'query resumes from a row id',
    titles(await query({ start_cursor: String(page.next_cursor) })),
    ['Ship beta', 'Kickoff'],
  )
  await query({ start_cursor: '1' }, '', '2025-09-03', 400)
  eq('2025-09-03 list type', [page.type!, page.page_or_data_source!], ['page_or_data_source', {}])
  eq('2025-09-03 row parent', results(page)[0]!.parent, {
    type: 'data_source_id',
    data_source_id: DS,
    database_id: DB,
  })

  const legacy = await request(
    at,
    'POST',
    `/v1/databases/${DB}/query`,
    { page_size: 1 },
    200,
    '2022-06-28',
  )
  eq('2022-06-28 list type', [legacy.type!, legacy.page_or_database!], ['page_or_database', {}])
  eq('2022-06-28 row parent', results(legacy)[0]!.parent, { type: 'database_id', database_id: DB })
  eq('page keys', Object.keys(results(legacy)[0]!), [
    'object',
    'id',
    'created_time',
    'last_edited_time',
    'created_by',
    'last_edited_by',
    'cover',
    'icon',
    'parent',
    'in_trash',
    'is_archived',
    'is_locked',
    'properties',
    'url',
    'public_url',
    'archived',
  ])
  const everything = await request(at, 'POST', '/v1/search', {}, 200, '2022-06-28')
  eq('search with no filter holds the database', results(everything)[0]!.object, 'database')
  eq(
    '2022-06-28 database carries its schema',
    Object.keys(results(everything)[0]!.properties as Record<string, JsonValue>).length,
    8,
  )
  const named = await request(at, 'POST', '/v1/search', { query: 'tasks' })
  eq(
    'search finds a data source by title',
    results(named).map((one) => one.object!),
    ['data_source'],
  )
}

const ROW = 'ffff1111-2222-3333-4444-555566667777'
const PAGE_B = 'bbbb2222-3333-4444-5555-666677778888'
const PAGE_C = 'cccc1111-2222-3333-4444-555566667777'
const MISSING = '00000000-0000-0000-0000-000000000000'

function keys(value: JsonValue | undefined): string[] {
  return Object.keys(value as Record<string, JsonValue>)
}

// Retrieve a page property item: one item for a plain value, a list of one
// item per element for title, rich text, people and relation, paged by
// position with a `next_url` that resumes the same request, under the run it
// arrived on.
async function propertyItems(at: string): Promise<void> {
  await request(at, 'POST', '/reset', { tenants: [TENANT], fixture: 'v1' })
  const number = { object: 'property_item', id: 'pri', type: 'number', number: 2 }
  eq('a number is one item', await request(at, 'GET', `/v1/pages/${ROW}/properties/pri`), number)
  eq(
    'a property is found by name',
    await request(at, 'GET', `/v1/pages/${ROW}/properties/Priority`),
    number,
  )
  eq('a title is a list of items', await request(at, 'GET', `/v1/pages/${ROW}/properties/title`), {
    object: 'list',
    results: [
      {
        object: 'property_item',
        id: 'title',
        type: 'title',
        title: { type: 'text', plain_text: 'Write spec', text: { content: 'Write spec' } },
      },
    ],
    next_cursor: null,
    has_more: false,
    type: 'property_item',
    property_item: { id: 'title', next_url: null, type: 'title', title: {} },
  })
  await request(at, 'GET', `/v1/pages/${ROW}/properties/nope`, undefined, 404)
  await request(at, 'GET', `/v1/pages/${MISSING}/properties/title`, undefined, 404)
  await request(at, 'GET', `/v1/pages/${ROW}/properties/title?start_cursor=nope`, undefined, 400)

  const run = '/_run/props'
  await request(at, 'POST', `${run}/reset`, { tenants: [TENANT], fixture: 'v1' })
  const row = await request(at, 'POST', `${run}/v1/pages`, {
    parent: { data_source_id: DS },
    properties: {
      Name: { title: [{ text: { content: 'Chunks' } }] },
      Notes: { rich_text: ['a', 'b', 'c'].map((content) => ({ text: { content } })) },
    },
  })
  const path = `${run}/v1/pages/${String(row.id)}/properties/nt`
  const first = await request(at, 'GET', `${path}?page_size=2`)
  const chunks = (body: Record<string, JsonValue>): JsonValue[] =>
    results(body).map((item) => (item.rich_text as Record<string, JsonValue>).plain_text!)
  eq(
    'a list pages by position',
    [chunks(first), first.next_cursor!, first.has_more!],
    [['a', 'b'], '2', true],
  )
  const next = String((first.property_item as Record<string, JsonValue>).next_url)
  eq('next_url resumes the request under its run', next, `${at}${path}?page_size=2&start_cursor=2`)
  const last = await request(at, 'GET', next.slice(at.length))
  eq(
    'the last page ends the list',
    [chunks(last), last.next_cursor!, last.has_more!],
    [['c'], null, false],
  )
}

// Create and update a database at 2022-06-28, the version
// @notionhq/notion-mcp-server 1.9.0 sends. An update's schema write moves the
// rows with it; a refused one changes nothing.
async function databaseWrites(at: string): Promise<void> {
  await request(at, 'POST', '/reset', { tenants: [TENANT], fixture: 'v1' })
  const v1 = (method: string, path: string, body?: JsonValue, status = 200) =>
    request(at, method, path, body, status, '2022-06-28')
  const made = await v1('POST', '/v1/databases', {
    parent: { type: 'page_id', page_id: PAGE },
    title: [{ text: { content: 'Reading list' } }],
    properties: {
      Name: { title: {} },
      Pages: { number: {} },
      Status: { select: { options: [{ name: 'Queued' }] } },
    },
  })
  const id = String(made.id)
  eq('a created database answers its schema', keys(made.properties), ['Name', 'Pages', 'Status'])
  const columnIds = (body: Record<string, JsonValue>): string[] =>
    Object.values(body.properties as Record<string, Record<string, JsonValue>>).map((column) =>
      String(column.id),
    )
  const pages = (made.properties as Record<string, Record<string, JsonValue>>).Pages!
  const seen = columnIds(made)
  check(
    'created column ids are minted, never the name',
    seen[0] === 'title' && seen.slice(1).every((one) => /^%3A\d+$/.test(one)),
    seen.join(' '),
  )
  eq('a created column', pages, {
    id: pages.id!,
    name: 'Pages',
    type: 'number',
    number: { format: 'number' },
  })
  eq(
    'a created option',
    (
      (made.properties as Record<string, Record<string, JsonValue>>).Status!.select as Record<
        string,
        JsonValue
      >
    ).options,
    [{ id: 'Queued', name: 'Queued', color: 'default' }],
  )
  eq('a created database parent', made.parent, { type: 'page_id', page_id: PAGE })
  eq(
    'a created database is a child of its page',
    results(await v1('GET', `/v1/blocks/${PAGE}/children`)).at(-1),
    {
      object: 'block',
      id,
      type: 'child_database',
      has_children: false,
      child_database: { title: 'Reading list' },
    },
  )
  const book = await v1('POST', '/v1/pages', {
    parent: { database_id: id },
    properties: { Name: { title: [{ text: { content: 'Dune' } }] }, Pages: { number: 412 } },
  })
  const updated = await v1('PATCH', `/v1/databases/${id}`, {
    title: [{ text: { content: 'Books' } }],
    properties: { Pages: { name: 'Length' }, Status: null, Rating: { number: {} } },
  })
  eq('an update renames, removes and adds', keys(updated.properties), ['Name', 'Length', 'Rating'])
  eq(
    'a renamed column keeps its id',
    (
      (updated.properties as Record<string, Record<string, JsonValue>>).Length as Record<
        string,
        JsonValue
      >
    ).id,
    pages.id!,
  )
  const rating = String(
    (updated.properties as Record<string, Record<string, JsonValue>>).Rating!.id,
  )
  check("an added column never takes a removed one's id", !seen.includes(rating), rating)
  seen.push(rating)
  const moved = (await v1('GET', `/v1/pages/${String(book.id)}`)).properties as Record<
    string,
    Record<string, JsonValue>
  >
  eq(
    'rows follow the schema',
    [Object.keys(moved), moved.Length!.number!, moved.Rating!.number!],
    [['Name', 'Length', 'Rating'], 412, null],
  )
  eq(
    'a renamed value answers by its old id',
    (await v1('GET', `/v1/pages/${String(book.id)}/properties/${String(pages.id)}`)).number,
    412,
  )
  eq(
    'a retitled database retitles its block',
    (await v1('GET', `/v1/blocks/${id}`)).child_database,
    { title: 'Books' },
  )
  for (const properties of [
    { Name: null },
    { Name: { number: {} } },
    { Other: { title: {} } },
    { Nope: null },
    { Nope: { name: 'Renamed' } },
    { Length: { name: 'Rating' } },
  ]) {
    await v1('PATCH', `/v1/databases/${id}`, { properties }, 400)
  }
  eq(
    'a refused update changes nothing',
    keys((await v1('GET', `/v1/databases/${id}`)).properties),
    ['Name', 'Length', 'Rating'],
  )
  await v1('PATCH', `/v1/databases/${id}`, { properties: { Rating: { name: 'title' } } })
  const item = (ref: string) => v1('GET', `/v1/pages/${String(book.id)}/properties/${ref}`)
  eq(
    'a name wins over an id',
    [(await item('title')).type!, (await item('Name')).object!],
    ['number', 'list'],
  )
  eq(
    'a schema key resolves by name first',
    keys((await v1('PATCH', `/v1/databases/${id}`, { properties: { title: null } })).properties),
    ['Name', 'Length'],
  )
  const later = await v1('PATCH', `/v1/databases/${id}`, { properties: { Score: { number: {} } } })
  const score = String((later.properties as Record<string, Record<string, JsonValue>>).Score!.id)
  check(
    'a later write never reuses a removed id',
    !seen.includes(score),
    `${score} ${seen.join(' ')}`,
  )
  await v1('PATCH', `/v1/databases/${MISSING}`, { title: [] }, 404)
  await v1(
    'POST',
    '/v1/databases',
    { parent: { page_id: PAGE }, properties: { N: { number: {} } } },
    400,
  )
  await v1('POST', '/v1/databases', { properties: { Name: { title: {} } } }, 400)
  await v1(
    'POST',
    '/v1/databases',
    { parent: { page_id: MISSING }, properties: { Name: { title: {} } } },
    404,
  )
  const titled = await v1('POST', '/v1/databases', {
    parent: { page_id: PAGE },
    properties: { title: { rich_text: {} }, Name: { title: {} } },
  })
  const titledIds = columnIds(titled)
  check(
    'a column named title does not take the title id',
    titledIds[1] === 'title' && titledIds[0] !== 'title',
    titledIds.join(' '),
  )
  const modern = await request(at, 'POST', '/v1/databases', {
    parent: { page_id: PAGE },
    title: [{ text: { content: 'Modern' } }],
    initial_data_source: { properties: { Task: { title: {} } } },
  })
  const source = (modern.data_sources as Record<string, JsonValue>[])[0]!
  eq('a 2025-09-03 create answers its data source', source.name, 'Modern')
  eq(
    'the data source holds the initial schema',
    keys((await request(at, 'GET', `/v1/data_sources/${String(source.id)}`)).properties),
    ['Task'],
  )
}

// Update a data source at 2025-09-03: the same schema write a database takes,
// on the one data source the fake derives for it. A second data source, a
// data source moved to another database and templates are what the fake does
// not model, and each says so.
async function dataSourceWrites(at: string): Promise<void> {
  await request(at, 'POST', '/reset', { tenants: [TENANT], fixture: 'v1' })
  const updated = await request(at, 'PATCH', `/v1/data_sources/${DS}`, {
    title: [{ text: { content: 'Backlog' } }],
    properties: { Priority: { name: 'Rank' }, Link: null },
  })
  eq('a data source update answers the data source', updated.object, 'data_source')
  eq('a data source update writes the schema', keys(updated.properties), [
    'Name',
    'Rank',
    'Done',
    'Stage',
    'Tags',
    'Due',
    'Notes',
  ])
  eq(
    'its database shows the new title',
    (await request(at, 'GET', `/v1/databases/${DB}`)).data_sources,
    [{ id: DS, name: 'Backlog' }],
  )
  const row = (await request(at, 'GET', `/v1/pages/${ROW}`)).properties as Record<
    string,
    Record<string, JsonValue>
  >
  eq('its rows follow', [row.Rank!.number!, 'Link' in row], [2, false])
  await request(at, 'PATCH', `/v1/data_sources/${DS}`, { parent: { database_id: MISSING } }, 400)
  await request(at, 'PATCH', `/v1/data_sources/${DS}`, { properties: { Name: null } }, 400)
  await request(at, 'PATCH', `/v1/data_sources/${MISSING}`, { title: [] }, 404)
  const schema = { Name: { title: {} } }
  await request(
    at,
    'POST',
    '/v1/data_sources',
    { parent: { database_id: DB }, properties: schema },
    400,
  )
  await request(
    at,
    'POST',
    '/v1/data_sources',
    { parent: { page_id: PAGE }, properties: schema },
    400,
  )
  await request(
    at,
    'POST',
    '/v1/data_sources',
    { parent: { database_id: MISSING }, properties: schema },
    404,
  )
  eq(
    'a data source lists no templates',
    await request(at, 'GET', `/v1/data_sources/${DS}/templates`),
    {
      templates: [],
      has_more: false,
      next_cursor: null,
    },
  )
  await request(at, 'GET', `/v1/data_sources/${DS}/templates?start_cursor=nope`, undefined, 400)
  await request(at, 'GET', `/v1/data_sources/${MISSING}/templates`, undefined, 404)
}

// Move a page between pages and data sources. Its child_page block follows it
// between pages, its title follows it into and out of a schema, and its own
// content never moves.
async function pageMoves(at: string): Promise<void> {
  await request(at, 'POST', '/reset', { tenants: [TENANT], fixture: 'v1' })
  const move = (id: string, parent: JsonValue, status = 200) =>
    request(at, 'POST', `/v1/pages/${id}/move`, { parent }, status)
  const children = async (id: string): Promise<JsonValue[]> =>
    results(await request(at, 'GET', `/v1/blocks/${id}/children`)).map((block) => block.id!)
  const under = await move(PAGE_C, { type: 'page_id', page_id: PAGE_B })
  eq('a moved page names its new parent', under.parent, { type: 'page_id', page_id: PAGE_B })
  eq(
    'its block leaves the old parent and joins the new one',
    [(await children(PAGE)).includes(PAGE_C), (await children(PAGE_B)).at(-1)!],
    [false, PAGE_C],
  )
  const row = await move(PAGE_C, { type: 'data_source_id', data_source_id: DS })
  eq('a page moved into a data source takes its schema', keys(row.properties), [
    'Name',
    'Priority',
    'Done',
    'Stage',
    'Tags',
    'Due',
    'Link',
    'Notes',
  ])
  eq('its title moves to the title column', titles({ results: [row] }), ['Q1 Goals'])
  eq('it leaves no block behind', (await children(PAGE_B)).includes(PAGE_C), false)
  check(
    'it is a row of the data source',
    titles(await request(at, 'POST', `/v1/data_sources/${DS}/query`, {})).includes('Q1 Goals'),
  )
  eq('its content stays with it', await children(PAGE_C), ['b-c1'])
  const out = await move(ROW, { type: 'page_id', page_id: PAGE })
  eq('a row moved under a page keeps only its title', keys(out.properties), ['title'])
  eq('a row moved under a page gets a block', (await children(PAGE)).at(-1), ROW)
  await move(PAGE, { type: 'page_id', page_id: PAGE }, 400)
  await move(PAGE, { type: 'page_id', page_id: ROW }, 400)
  await move(MISSING, { type: 'page_id', page_id: PAGE }, 404)
  await move(PAGE_B, { type: 'page_id', page_id: MISSING }, 404)
  await move(PAGE_B, { type: 'workspace' }, 400)
}

// A page write names only properties its parent has: a column of its data
// source, by name or id, or `title` outside one. Any other key is refused in
// live's words and changes nothing: no row, no block, no value, no minted
// option, no trash bit.
async function pagePropertyWrites(at: string): Promise<void> {
  await request(at, 'POST', '/reset', { tenants: [TENANT], fixture: 'v1' })
  const title = { title: [{ text: { content: 'Kickoff' } }] }
  const rows = async (): Promise<JsonValue[]> =>
    results(await request(at, 'POST', `/v1/data_sources/${DS}/query`, {})).map((row) => row.id!)
  const children = async (): Promise<JsonValue[]> =>
    results(await request(at, 'GET', `/v1/blocks/${PAGE}/children`)).map((block) => block.id!)
  const options = async (): Promise<JsonValue> =>
    (
      (await request(at, 'GET', `/v1/data_sources/${DS}`)).properties as Record<
        string,
        Record<string, JsonValue>
      >
    ).Stage!.select!

  const seeded = await rows()
  const unknown = await request(
    at,
    'POST',
    '/v1/pages',
    { parent: { data_source_id: DS }, properties: { Name: title, 'Net PnL %': { number: 1 } } },
    400,
  )
  eq(
    'a create names the unknown column',
    unknown.message,
    'Net PnL % is not a property that exists.',
  )
  eq('a refused create makes no row', await rows(), seeded)

  const row = await request(at, 'GET', `/v1/pages/${ROW}`)
  const stage = await options()
  const second = await request(
    at,
    'PATCH',
    `/v1/pages/${ROW}`,
    {
      properties: { Stage: { select: { name: 'Trade' } }, Month: title, Type: { number: 1 } },
      in_trash: true,
    },
    400,
  )
  eq('a second title is an unknown column', second.message, 'Month is not a property that exists.')
  const kept = await request(at, 'GET', `/v1/pages/${ROW}`)
  eq(
    'a refused update writes nothing',
    [kept.properties!, kept.in_trash!],
    [row.properties!, false],
  )
  eq('a refused update mints no option', await options(), stage)

  const byId = await request(at, 'POST', '/v1/pages', {
    parent: { data_source_id: DS },
    properties: { title, pri: { number: 5 } },
  })
  eq(
    'a column named by its id lands under its name',
    [keys(byId.properties).includes('title'), titles({ results: [byId] })],
    [false, ['Kickoff']],
  )
  eq(
    'a number written by id reads back by name',
    (byId.properties as Record<string, Record<string, JsonValue>>).Priority!.number,
    5,
  )

  const listed = await children()
  for (const parent of [{ page_id: PAGE }, { workspace: true }]) {
    const extra = await request(
      at,
      'POST',
      '/v1/pages',
      { parent, properties: { title, 'AIME (8x)': { number: 0.1 } } },
      400,
    )
    eq(
      'outside a data source only title exists',
      extra.message,
      'AIME (8x) is not a property that exists.',
    )
  }
  eq('a refused child page makes no block', await children(), listed)
  await request(at, 'PATCH', `/v1/pages/${PAGE_C}`, { properties: { Name: title } }, 400)
  const renamed = await request(at, 'PATCH', `/v1/pages/${PAGE_C}`, { properties: { title } })
  eq('a page under a page keeps one property', keys(renamed.properties), ['title'])
}

// Every operation @notionhq/notion-mcp-server exposes at the two versions this
// fake is pinned to, from each one's scripts/notion-openapi.json, sent with the
// Notion-Version that version sends: 1.9.0 is what vfs-bench drives, 2.5.2 is
// the newest. A missing id reaches each operation without changing anything,
// so every answer is the route's own, and only a path no route serves answers
// invalid_request_url.
const MCP_OPERATIONS: ReadonlyArray<
  readonly [string, string, ReadonlyArray<readonly [string, string]>]
> = [
  [
    '1.9.0',
    '2022-06-28',
    [
      ['GET', '/v1/users/{user_id}'],
      ['GET', '/v1/users'],
      ['GET', '/v1/users/me'],
      ['POST', '/v1/databases/{database_id}/query'],
      ['POST', '/v1/search'],
      ['GET', '/v1/blocks/{block_id}/children'],
      ['PATCH', '/v1/blocks/{block_id}/children'],
      ['GET', '/v1/blocks/{block_id}'],
      ['PATCH', '/v1/blocks/{block_id}'],
      ['DELETE', '/v1/blocks/{block_id}'],
      ['GET', '/v1/pages/{page_id}'],
      ['PATCH', '/v1/pages/{page_id}'],
      ['POST', '/v1/pages'],
      ['POST', '/v1/databases'],
      ['PATCH', '/v1/databases/{database_id}'],
      ['GET', '/v1/databases/{database_id}'],
      ['GET', '/v1/pages/{page_id}/properties/{property_id}'],
      ['GET', '/v1/comments'],
      ['POST', '/v1/comments'],
    ],
  ],
  [
    '2.5.2',
    '2025-09-03',
    [
      ['GET', '/v1/users/{user_id}'],
      ['GET', '/v1/users'],
      ['GET', '/v1/users/me'],
      ['POST', '/v1/search'],
      ['GET', '/v1/blocks/{block_id}/children'],
      ['PATCH', '/v1/blocks/{block_id}/children'],
      ['GET', '/v1/blocks/{block_id}'],
      ['PATCH', '/v1/blocks/{block_id}'],
      ['DELETE', '/v1/blocks/{block_id}'],
      ['GET', '/v1/pages/{page_id}'],
      ['PATCH', '/v1/pages/{page_id}'],
      ['POST', '/v1/pages'],
      ['GET', '/v1/pages/{page_id}/properties/{property_id}'],
      ['GET', '/v1/comments'],
      ['POST', '/v1/comments'],
      ['POST', '/v1/data_sources/{data_source_id}/query'],
      ['GET', '/v1/data_sources/{data_source_id}'],
      ['PATCH', '/v1/data_sources/{data_source_id}'],
      ['POST', '/v1/data_sources'],
      ['GET', '/v1/data_sources/{data_source_id}/templates'],
      ['GET', '/v1/databases/{database_id}'],
      ['POST', '/v1/pages/{page_id}/move'],
      ['GET', '/v1/pages/{page_id}/markdown'],
      ['PATCH', '/v1/pages/{page_id}/markdown'],
    ],
  ],
]

async function answer(
  at: string,
  method: string,
  path: string,
  version = '2022-06-28',
): Promise<[number, Record<string, JsonValue>]> {
  const response = await fetch(at + path, {
    method,
    headers: {
      Authorization: `Bearer ${TENANT}`,
      'Notion-Version': version,
      'Content-Type': 'application/json',
    },
    ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
  })
  return [response.status, (await response.json()) as Record<string, JsonValue>]
}

async function mcpSurface(at: string): Promise<void> {
  await request(at, 'POST', '/reset', { tenants: [TENANT], fixture: 'v1' })
  for (const [server, version, operations] of MCP_OPERATIONS) {
    for (const [method, template] of operations) {
      const path = template.replace(/\{\w+\}/g, MISSING)
      const [status, body] = await answer(at, method, path, version)
      check(
        `${server} ${method} ${template} is served`,
        body.code !== 'invalid_request_url',
        `${String(status)} ${String(body.code)}`,
      )
    }
  }
  const anonymous = await fetch(`${at}/v1/pages/${PAGE}/comments`)
  eq(
    'an unrouted path checks the token first',
    [anonymous.status, ((await anonymous.json()) as Record<string, JsonValue>).code!],
    [401, 'unauthorized'],
  )
  for (const [method, path] of [
    ['GET', `/v1/pages/${PAGE}/comments`],
    ['POST', '/v1/pages/'],
  ] as const) {
    eq(`${method} ${path} is an invalid request url`, await answer(at, method, path), [
      400,
      {
        object: 'error',
        status: 400,
        code: 'invalid_request_url',
        message: 'Invalid request URL.',
      },
    ])
  }
}

async function main(): Promise<void> {
  const fake = await launch()
  const at = fake.endpoint
  try {
    await request(at, 'POST', '/reset', { tenants: [TENANT], fixture: 'v1' })
    for (const type of ['heading_1', 'heading_2', 'heading_3', 'divider', 'image', 'code']) {
      const payload: JsonValue =
        type === 'image'
          ? { type: 'external', external: { url: 'https://example.com/a.png' } }
          : type === 'divider'
            ? {}
            : { rich_text: [], ...(type === 'code' ? { language: 'plain text' } : {}) }
      const made = results(
        await request(at, 'PATCH', `/v1/blocks/${PAGE}/children`, {
          children: [{ type, [type]: payload }],
        }),
      )[0]!
      const id = String(made.id)
      await request(
        at,
        'PATCH',
        `/v1/blocks/${id}/children`,
        { children: [paragraph('refused')] },
        400,
      )
      eq(
        'refused parent stays childless',
        (await request(at, 'GET', `/v1/blocks/${id}`)).has_children,
        false,
      )
      eq(
        'refused append inserts no children',
        results(await request(at, 'GET', `/v1/blocks/${id}/children`)),
        [],
      )
    }
    const heading = results(
      await request(at, 'PATCH', `/v1/blocks/${PAGE}/children`, {
        children: [{ type: 'heading_1', heading_1: { rich_text: [], is_toggleable: true } }],
      }),
    )[0]!
    const hid = String(heading.id)
    await request(at, 'PATCH', `/v1/blocks/${hid}/children`, { children: [paragraph('nested')] })
    const renamed = await request(at, 'PATCH', `/v1/blocks/${hid}`, {
      heading_1: { rich_text: [{ text: { content: 'Renamed' } }] },
    })
    eq(
      'update preserves omitted toggle state',
      (renamed.heading_1 as Record<string, JsonValue>).is_toggleable,
      true,
    )
    eq('update preserves children', renamed.has_children, true)
    eq(
      'rich text normalized',
      (
        (renamed.heading_1 as Record<string, JsonValue>).rich_text as Record<string, JsonValue>[]
      )[0]!.plain_text,
      'Renamed',
    )
    await request(at, 'PATCH', `/v1/blocks/${hid}`, { heading_1: { is_toggleable: false } }, 400)
    await request(at, 'PATCH', `/v1/blocks/${hid}`, { type: { heading_1: { rich_text: [] } } }, 400)
    await request(at, 'PATCH', `/v1/blocks/${hid}`, { heading_1: { children: [] } }, 400)
    await request(at, 'PATCH', '/v1/blocks/00000000-0000-0000-0000-000000000000', {}, 404)
    await request(at, 'PATCH', `/v1/blocks/${hid}`, { archived: true })
    eq(
      'archive alias visible on read',
      (await request(at, 'GET', `/v1/blocks/${hid}`)).in_trash,
      true,
    )
    await request(at, 'PATCH', `/v1/blocks/${hid}`, { in_trash: false })

    const before = results(await request(at, 'GET', `/v1/blocks/${PAGE}/children`))
    for (const type of ['child_page', 'child_database']) {
      const relationship = { type, [type]: { title: 'Invalid relationship' } }
      for (const child of [
        relationship,
        { type: 'toggle', toggle: { rich_text: [], children: [relationship] } },
      ]) {
        const children = [paragraph('must not be inserted'), child]
        await request(at, 'PATCH', `/v1/blocks/${PAGE}/children`, { children }, 400)
        await request(
          at,
          'POST',
          '/v1/pages',
          { parent: { page_id: PAGE }, properties: {}, children },
          400,
        )
        eq(
          'relationship refusal leaves parent unchanged',
          results(await request(at, 'GET', `/v1/blocks/${PAGE}/children`)),
          before,
        )
      }
    }
    for (const children of [
      [JSON.stringify(paragraph('bad'))],
      [paragraph('valid'), { type: 'divider', divider: { children: [paragraph('invalid')] } }],
      null,
    ]) {
      await request(
        at,
        'POST',
        '/v1/pages',
        { parent: { page_id: PAGE }, properties: {}, children },
        400,
      )
      eq(
        'invalid page leaves parent unchanged',
        results(await request(at, 'GET', `/v1/blocks/${PAGE}/children`)),
        before,
      )
    }
    await request(
      at,
      'PATCH',
      `/v1/blocks/${PAGE}/children`,
      { after: before[0]!.id!, children: [paragraph('valid'), 'invalid'] },
      400,
    )
    eq(
      'invalid append does not insert or reorder',
      results(await request(at, 'GET', `/v1/blocks/${PAGE}/children`)),
      before,
    )
    const page = await request(at, 'POST', '/v1/pages', {
      parent: { page_id: PAGE },
      properties: { title: { title: [{ text: { content: 'With children' } }] } },
      children: [
        paragraph('first'),
        { type: 'toggle', toggle: { rich_text: [], children: [paragraph('inside')] } },
        paragraph('last'),
      ],
    })
    const blocks = results(await request(at, 'GET', `/v1/blocks/${String(page.id)}/children`))
    eq(
      'page children retain order',
      blocks.map((block) => block.type!),
      ['paragraph', 'toggle', 'paragraph'],
    )
    eq('nested child tracked separately', blocks[1]!.has_children, true)
    check(
      'children omitted from returned payload',
      !('children' in (blocks[1]!.toggle as Record<string, JsonValue>)),
    )
    const nested = results(await request(at, 'GET', `/v1/blocks/${String(blocks[1]!.id)}/children`))
    eq(
      'nested child readable',
      (
        (nested[0]!.paragraph as Record<string, JsonValue>).rich_text as Record<string, JsonValue>[]
      )[0]!.plain_text,
      'inside',
    )
    const deep = results(
      await request(at, 'PATCH', `/v1/blocks/${String(nested[0]!.id)}/children`, {
        children: [paragraph('deep descendant')],
      }),
    )
    await request(at, 'PATCH', `/v1/blocks/${String(nested[0]!.id)}`, { archived: true })
    const childPage = await request(at, 'POST', '/v1/pages', {
      parent: { page_id: page.id! },
      properties: {},
      children: [paragraph('preserved page content')],
    })
    const childContent = results(
      await request(at, 'GET', `/v1/blocks/${String(childPage.id)}/children`),
    )
    const untouched = await request(at, 'GET', `/v1/blocks/${hid}`)
    await request(at, 'PATCH', `/v1/pages/${String(page.id)}/markdown`, {
      type: 'replace_content',
      replace_content: { new_str: 'replacement' },
    })
    for (const block of [...blocks, ...nested, ...deep]) {
      await request(at, 'GET', `/v1/blocks/${String(block.id)}`, undefined, 404)
      eq(
        'removed subtree has no stored children',
        results(await request(at, 'GET', `/v1/blocks/${String(block.id)}/children`)),
        [],
      )
    }
    await request(at, 'GET', `/v1/pages/${String(childPage.id)}`)
    eq(
      'replacement preserves child page contents',
      results(await request(at, 'GET', `/v1/blocks/${String(childPage.id)}/children`)),
      childContent,
    )
    eq(
      'replacement leaves other trees intact',
      await request(at, 'GET', `/v1/blocks/${hid}`),
      untouched,
    )
    eq(
      'replacement preserves child page block and inserts new content',
      results(await request(at, 'GET', `/v1/blocks/${String(page.id)}/children`))
        .map((block) => String(block.type))
        .sort(),
      ['child_page', 'paragraph'],
    )
    // Resume mixed page/data-source results at every boundary in both
    // directions. Small pages exercise the database keyset instead of a
    // full materialized search on each cursor request (#1202).
    for (const [direction, query] of [
      ['ascending', ''],
      ['descending', ''],
      ['ascending', 'o'],
      ['descending', 'o'],
    ] as const) {
      const base = {
        sort: { direction, timestamp: 'last_edited_time' },
        ...(query === '' ? {} : { query }),
      }
      const all = results(await request(at, 'POST', '/v1/search', base)).map((row) => row.id!)
      const paged: JsonValue[] = []
      let cursor: JsonValue = null
      do {
        const page = await request(at, 'POST', '/v1/search', {
          ...base,
          page_size: 1,
          ...(cursor === null ? {} : { start_cursor: cursor }),
        })
        paged.push(...results(page).map((row) => row.id!))
        cursor = page.next_cursor ?? null
        check('cursor makes progress', paged.length <= all.length)
      } while (cursor !== null)
      eq(`keyset pagination preserves ${direction} order for "${query}"`, paged, all)
      if (query !== '') check('a title query pages across more than one match', all.length > 1)
    }
    const folded = await request(at, 'POST', '/v1/pages', {
      parent: { page_id: PAGE },
      properties: { title: { title: [{ text: { content: 'Équipe plan' } }] } },
    })
    const unicode = await request(at, 'POST', '/v1/search', { query: 'équipe', page_size: 1 })
    eq(
      'search folds a non-ASCII title query',
      results(unicode).map((row) => row.id!),
      [folded.id!],
    )
    eq('a folded query that fits one page has no next page', unicode.has_more, false)
    await liveReads(at)
    await propertyItems(at)
    await databaseWrites(at)
    await dataSourceWrites(at)
    await pageMoves(at)
    await pagePropertyWrites(at)
    await mcpSurface(at)
    process.stdout.write(`notion selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
