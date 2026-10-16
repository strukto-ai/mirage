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
import { NotionAccessor } from '../../accessor/notion.ts'
import { FileChangeKind, PathSpec, type JsonValue } from '../../types.ts'
import { NotionAPIError, type NotionTransport } from './client.ts'
import { NotionEventHook } from './watch.ts'

const { CREATE: C, UPDATE: U, DELETE: D, UNKNOWN: X } = FileChangeKind
const PLANS = '/n/pages/Plans__p1'
const Q4 = `${PLANS}/Q4__p2`
const TASKS = '/n/databases/Tasks__db1/Open__ds1'
const ROW = `${TASKS}/Fix_bug__r1`
const ROOT = new PathSpec({ virtual: '/n', directory: '/n', vfsPath: '' })

function page(id: string, title: string, parent: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    parent,
    properties: { Name: { type: 'title', title: [{ plain_text: title }] } },
  }
}

interface Fake {
  hook: NotionEventHook
  objects: Record<string, Record<string, unknown>>
  calls: string[]
}

function fake(): Fake {
  const calls: string[] = []
  const objects: Record<string, Record<string, unknown>> = {
    p1: page('p1', 'Plans', { type: 'workspace', workspace: true }),
    p2: page('p2', 'Q4', { type: 'page_id', page_id: 'p1' }),
    p3: page('p3', 'Aside', { type: 'block_id', block_id: 'k1' }),
    r1: page('r1', 'Fix bug', { type: 'data_source_id', data_source_id: 'ds1' }),
    db1: { id: 'db1', title: [{ plain_text: 'Tasks' }] },
    ds1: {
      id: 'ds1',
      title: [{ plain_text: 'Open' }],
      parent: { type: 'database_id', database_id: 'db1' },
    },
  }
  const transport: NotionTransport = {
    callTool(_name, args) {
      const id = String(args.page_id ?? args.database_id ?? args.data_source_id)
      calls.push(id)
      const found = objects[id]
      if (found === undefined) return Promise.reject(new NotionAPIError('object_not_found', 404))
      return Promise.resolve({ ...found })
    },
  }
  return { hook: new NotionEventHook(new NotionAccessor(transport)), objects, calls }
}

function event(
  eventType: string,
  entityId: string,
  data: Record<string, JsonValue> = {},
): Record<string, JsonValue> {
  return {
    type: eventType,
    entity: { id: entityId, type: eventType.split('.')[0] ?? '' },
    data,
  }
}

async function map(
  hook: NotionEventHook,
  body: Record<string, JsonValue>,
): Promise<[FileChangeKind, string][]> {
  const events = await hook.toEvents(ROOT, body.type as string, body)
  return events.map((e) => [e.kind, e.path.virtual])
}

describe('NotionEventHook', () => {
  it('updates page.json through the parents of a page edit', async () => {
    const { hook, calls } = fake()
    expect(await map(hook, event('page.content_updated', 'p2'))).toEqual([[U, `${Q4}/page.json`]])
    await map(hook, event('page.content_updated', 'p2'))
    expect(calls).toEqual(['p2', 'p1'])
  })

  it("also updates a row's data source rows", async () => {
    const { hook } = fake()
    expect(
      await map(hook, event('page.properties_updated', 'r1', { updated_properties: ['a'] })),
    ).toEqual([
      [U, `${ROW}/page.json`],
      [U, `${TASKS}/rows.jsonl`],
    ])
    expect(await map(hook, event('page.created', 'r1'))).toEqual([
      [C, `${ROW}/page.json`],
      [U, `${TASKS}/rows.jsonl`],
    ])
  })

  it('moves the directory on a retitle', async () => {
    const { hook, objects } = fake()
    await map(hook, event('page.content_updated', 'p2'))
    objects.p1 = page('p1', 'Ideas', { type: 'workspace', workspace: true })
    expect(
      await map(hook, event('page.properties_updated', 'p1', { updated_properties: ['title'] })),
    ).toEqual([
      [X, PLANS],
      [X, '/n/pages/Ideas__p1'],
    ])
    expect(await map(hook, event('page.content_updated', 'p2'))).toEqual([
      [U, '/n/pages/Ideas__p1/Q4__p2/page.json'],
    ])
  })

  it('is UNKNOWN on the parent of an unseen retitled page', async () => {
    const { hook } = fake()
    expect(
      await map(hook, event('page.properties_updated', 'p2', { updated_properties: ['title'] })),
    ).toEqual([[X, PLANS]])
  })

  it('is UNKNOWN where a moved page was and where it is', async () => {
    const { hook, objects } = fake()
    await map(hook, event('page.content_updated', 'p2'))
    objects.p2 = page('p2', 'Q4', { type: 'workspace', workspace: true })
    expect(await map(hook, event('page.moved', 'p2'))).toEqual([
      [X, Q4],
      [X, '/n/pages/Q4__p2'],
    ])
  })

  it('removes a deleted page and maps an unlisted one to nothing', async () => {
    const { hook } = fake()
    expect(await map(hook, event('page.deleted', 'p2'))).toEqual([[D, Q4]])
    expect(await map(hook, event('page.content_updated', 'p3'))).toEqual([])
    expect(await map(hook, event('page.content_updated', 'gone'))).toEqual([])
    expect(await map(hook, event('comment.created', 'p1'))).toEqual([])
  })

  it('maps data sources and databases', async () => {
    const { hook } = fake()
    expect(await map(hook, event('data_source.content_updated', 'ds1'))).toEqual([
      [U, `${TASKS}/rows.jsonl`],
    ])
    expect(await map(hook, event('data_source.created', 'ds1'))).toEqual([
      [C, `${TASKS}/data_source.json`],
      [C, `${TASKS}/rows.jsonl`],
      [U, '/n/databases/Tasks__db1/database.json'],
    ])
    expect(await map(hook, event('data_source.schema_updated', 'ds1'))).toEqual([
      [X, TASKS],
      [U, '/n/databases/Tasks__db1/database.json'],
    ])
    expect(await map(hook, event('database.moved', 'db1'))).toEqual([
      [U, '/n/databases/Tasks__db1/database.json'],
    ])
    expect(await map(hook, event('database.deleted', 'db1'))).toEqual([
      [D, '/n/databases/Tasks__db1'],
    ])
  })

  it('is UNKNOWN on the mount for a move of an unseen page', async () => {
    const { hook } = fake()
    expect(await map(hook, event('page.moved', 'p2'))).toEqual([
      [X, '/n'],
      [X, Q4],
    ])
    expect(await map(hook, event('page.moved', 'r1'))).toEqual([
      [X, '/n'],
      [X, ROW],
      [U, `${TASKS}/rows.jsonl`],
    ])
  })
})
