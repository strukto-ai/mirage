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
import { AirtableAccessor } from '../../accessor/airtable.ts'
import { type Delta, FileChangeKind, PathSpec } from '../../types.ts'
import { AirtableDeltaHook } from './watch.ts'

const { CREATE: C, UPDATE: U, DELETE: D, UNKNOWN: X } = FileChangeKind
const API = 'https://api.airtable.com/v0'
const BASE = '/at/bases/Roadmap__appA'
const FEATURES = `${BASE}/Features__tblF`

type Row = Record<string, unknown>

/**
 * Bases, their schemas, and each webhook's payloads, numbered from 1 and kept
 * from `oldest` on, served two to a page.
 */
class FakeAirtable {
  bases: Row[] = [{ id: 'appA', name: 'Roadmap' }]
  tables: Record<string, Row[]> = { appA: [{ id: 'tblF', name: 'Features' }] }
  hooks: Record<string, Record<string, Row[]>> = { appA: { achH: [] } }
  oldest = 1
  calls: string[] = []

  readonly fetchFn = ((input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return Promise.resolve(this.answer(url.pathname.slice('/v0'.length), url.searchParams))
  }) as typeof fetch

  private answer(path: string, query: URLSearchParams): Response {
    if (path === '/meta/bases') {
      this.calls.push('bases')
      return json({ bases: this.bases })
    }
    const parts = path.split('/')
    if (parts[1] === 'meta') {
      const baseId = parts[3] ?? ''
      this.calls.push(`tables ${baseId}`)
      return json({ tables: this.tables[baseId] ?? [] })
    }
    const hooks = this.hooks[parts[2] ?? ''] ?? {}
    if (parts.length === 4) {
      return json({
        webhooks: Object.entries(hooks).map(([id, log]) => ({
          id,
          cursorForNextPayload: log.length + 1,
        })),
      })
    }
    const log = hooks[parts[4] ?? '']
    if (log === undefined) return json({ error: 'NOT_FOUND' }, 404)
    const start = Math.max(Number(query.get('cursor') ?? 1), this.oldest)
    const page = log.slice(start - 1, start + 1)
    return json({
      payloads: page,
      cursor: start + page.length,
      mightHaveMore: start + page.length <= log.length,
    })
  }

  push(payload: Row, hookId = 'achH'): void {
    const log = this.hooks.appA?.[hookId]
    if (log === undefined) throw new Error(`no webhook ${hookId}`)
    log.push(payload)
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function records(tableId = 'tblF'): Row {
  return { changedTablesById: { [tableId]: { changedRecordsById: { rec1: { current: {} } } } } }
}

function root(vfsPath = ''): PathSpec {
  const virtual = vfsPath !== '' ? `/at/${vfsPath}` : '/at'
  return new PathSpec({ virtual, directory: virtual, vfsPath })
}

function hookFor(fake: FakeAirtable): AirtableDeltaHook {
  const accessor = new AirtableAccessor(
    { token: 't', baseUrl: API, requestsPerSecond: 10_000 },
    { fetchFn: fake.fetchFn },
  )
  return new AirtableDeltaHook(accessor)
}

function pairs(delta: Delta): [FileChangeKind, string][] {
  return delta.changes.map((c) => [c.kind, c.path.virtual])
}

describe('AirtableDeltaHook', () => {
  it('starts a baseline at the present and reads on at each ping', async () => {
    const fake = new FakeAirtable()
    fake.push(records())
    const hook = hookFor(fake)
    const base = await hook.pull(root(), null)
    expect(base.changes).toEqual([])
    fake.push(records())
    fake.push(records())
    fake.push({ changedTablesById: { tblF: { changedViewsById: { v: {} } } } })
    const delta = await hook.pull(root(), base.checkpoint)
    expect(pairs(delta)).toEqual([
      [U, `${FEATURES}/records.jsonl`],
      [X, `${FEATURES}/views`],
    ])
    expect((await hook.pull(root(), delta.checkpoint)).changes).toEqual([])
  })

  it('names the files of fields and tables', async () => {
    const fake = new FakeAirtable()
    const hook = hookFor(fake)
    const base = await hook.pull(root(), null)
    fake.push({
      changedTablesById: { tblF: { changedFieldsById: { fld1: { current: {} } } } },
      createdTablesById: { tblN: { metadata: { name: 'Notes' }, fieldsById: {} } },
    })
    const delta = await hook.pull(root(), base.checkpoint)
    expect(pairs(delta)).toEqual([
      [C, `${BASE}/Notes__tblN/table.json`],
      [C, `${BASE}/Notes__tblN/records.jsonl`],
      [X, `${BASE}/Notes__tblN/views`],
      [U, `${BASE}/base.json`],
      [U, `${FEATURES}/table.json`],
      [U, `${FEATURES}/records.jsonl`],
      [X, `${FEATURES}/views`],
    ])
    fake.push({
      changedTablesById: {
        tblN: { changedMetadata: { current: { name: 'Ideas' }, previous: { name: 'Notes' } } },
      },
    })
    fake.push({ destroyedTableIds: ['tblF'] })
    fake.push(records('tblN'))
    const next = await hook.pull(root(), delta.checkpoint)
    expect(pairs(next)).toEqual([
      [X, `${BASE}/Notes__tblN`],
      [X, `${BASE}/Ideas__tblN`],
      [U, `${BASE}/base.json`],
      [D, FEATURES],
      [U, `${BASE}/Ideas__tblN/records.jsonl`],
      [X, `${BASE}/Ideas__tblN/views`],
    ])
    expect(fake.calls.filter((c) => c === 'tables appA')).toHaveLength(1)
  })

  it('is UNKNOWN on the watch root for lost payloads', async () => {
    const fake = new FakeAirtable()
    const hook = hookFor(fake)
    const base = await hook.pull(root(), null)
    fake.push(records())
    fake.push(records())
    fake.oldest = 2
    const delta = await hook.pull(root(), base.checkpoint)
    expect(pairs(delta)[0]).toEqual([X, '/at'])
    fake.push({ error: true, code: 'INVALID_HOOK' })
    expect(pairs(await hook.pull(root(), delta.checkpoint))).toEqual([[X, '/at']])
  })

  it('loses a webhook that is gone and reads a new one from its start', async () => {
    const fake = new FakeAirtable()
    const hook = hookFor(fake)
    const base = await hook.pull(root(), null)
    fake.hooks.appA = { achNew: [] }
    fake.push(records(), 'achNew')
    expect(pairs(await hook.pull(root(), base.checkpoint))).toEqual([
      [X, '/at'],
      [U, `${FEATURES}/records.jsonl`],
      [X, `${FEATURES}/views`],
    ])
  })

  it('follows bases that come and go and lists no bases for a base root', async () => {
    const fake = new FakeAirtable()
    const hook = hookFor(fake)
    const base = await hook.pull(root(), null)
    fake.bases = [{ id: 'appB', name: 'Ops' }]
    fake.tables.appB = []
    fake.hooks.appB = {}
    expect(pairs(await hook.pull(root(), base.checkpoint))).toEqual([
      [X, '/at/bases/Ops__appB'],
      [D, BASE],
    ])
    const tableRoot = root('bases/Roadmap__appA/Features__tblF')
    fake.calls = []
    const start = await hook.pull(tableRoot, null)
    fake.push(records())
    fake.push(records('tblOther'))
    fake.tables.appA?.push({ id: 'tblOther', name: 'Other' })
    expect(pairs(await hook.pull(tableRoot, start.checkpoint))).toEqual([
      [U, `${FEATURES}/records.jsonl`],
      [X, `${FEATURES}/views`],
    ])
    expect(fake.calls).not.toContain('bases')
  })

  it('reads nothing of a base the mount leaves out', async () => {
    const fake = new FakeAirtable()
    const accessor = new AirtableAccessor(
      { token: 't', baseUrl: API, baseIds: ['appB'], requestsPerSecond: 10_000 },
      { fetchFn: fake.fetchFn },
    )
    const hook = new AirtableDeltaHook(accessor)
    const baseRoot = root('bases/Roadmap__appA')
    const base = await hook.pull(baseRoot, null)
    fake.push(records())
    expect((await hook.pull(baseRoot, base.checkpoint)).changes).toEqual([])
    expect(fake.calls).toEqual([])
  })
})
