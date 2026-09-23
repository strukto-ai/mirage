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
    await liveReads(at)
    process.stdout.write(`notion selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
