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

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AirtableAccount, BASES, TABLES } from '../../../tests/fixtures/airtable_account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { type Delta, FileChangeKind, PathSpec } from '../../types.ts'
import type { AirtableConfig } from './config.ts'
import { AirtableDeltaHook } from './events.ts'

const { CREATE: C, UPDATE: U, DELETE: D, UNKNOWN: X } = FileChangeKind
// The world integ/fixtures/airtable/events.json seeds: one base holding one
// table, and a page of two payloads.
const ROADMAP = 'appRoadmap0000001'
const FEATURES_ID = 'tblFeatures000001'
const OPS = 'appOps00000000001'
const NOTES = 'tblNotes000000001'
const OTHER = 'tblOther000000001'
const BASE = `/at/bases/Roadmap__${ROADMAP}`
const FEATURES = `${BASE}/Features__${FEATURES_ID}`

type Row = Parameters<AirtableAccount['push']>[1]

/** The account and the webhook its base already has. */
interface World {
  account: AirtableAccount
  hook: string
}

let origin = ''
let opened: AirtableAccount[] = []

beforeAll(async () => {
  origin = await serve('airtable')
})

afterEach(async () => {
  const closing = opened
  opened = []
  await Promise.all(closing.map((account) => account.run.close()))
})

async function worldOf(): Promise<World> {
  const account = new AirtableAccount(origin)
  opened.push(account)
  await account.reset(undefined, 'events')
  const hook = await account.webhook(ROADMAP)
  await account.recordRequests()
  return { account, hook }
}

// Each base listing and table listing asked, in order.
async function calls(world: World): Promise<string[]> {
  const out: string[] = []
  for (const r of await world.account.listed()) {
    if (r.route === BASES) out.push('bases')
    else if (r.route === TABLES) out.push(`tables ${r.path.split('/')[4] ?? ''}`)
  }
  return out
}

function records(tableId = FEATURES_ID): Row {
  return {
    changedTablesById: {
      [tableId]: { changedRecordsById: { rec00000000000001: { current: {} } } },
    },
  }
}

function root(vfsPath = ''): PathSpec {
  const virtual = vfsPath !== '' ? `/at/${vfsPath}` : '/at'
  return new PathSpec({ virtual, directory: virtual, vfsPath })
}

function hookFor(world: World, overrides: Partial<AirtableConfig> = {}): AirtableDeltaHook {
  return new AirtableDeltaHook(world.account.accessor(overrides))
}

function pairs(delta: Delta): [FileChangeKind, string][] {
  return delta.changes.map((c) => [c.kind, c.path.virtual])
}

describe('AirtableDeltaHook', () => {
  it('starts a baseline at the present and reads on at each ping', async () => {
    const world = await worldOf()
    await world.account.push(world.hook, records())
    const hook = hookFor(world)
    const base = await hook.pull(root(), null)
    expect(base.changes).toEqual([])
    await world.account.push(world.hook, records())
    await world.account.push(world.hook, records())
    await world.account.push(world.hook, {
      changedTablesById: { [FEATURES_ID]: { changedViewsById: { v: {} } } },
    })
    const delta = await hook.pull(root(), base.checkpoint)
    expect(pairs(delta)).toEqual([
      [U, `${FEATURES}/records.jsonl`],
      [X, `${FEATURES}/views`],
    ])
    expect((await hook.pull(root(), delta.checkpoint)).changes).toEqual([])
  })

  it('names the files of fields and tables', async () => {
    const world = await worldOf()
    const hook = hookFor(world)
    const base = await hook.pull(root(), null)
    await world.account.push(world.hook, {
      changedTablesById: {
        [FEATURES_ID]: { changedFieldsById: { fldNew00000000001: { current: {} } } },
      },
      createdTablesById: { [NOTES]: { metadata: { name: 'Notes' }, fieldsById: {} } },
    })
    const delta = await hook.pull(root(), base.checkpoint)
    expect(pairs(delta)).toEqual([
      [C, `${BASE}/Notes__${NOTES}/table.json`],
      [C, `${BASE}/Notes__${NOTES}/records.jsonl`],
      [X, `${BASE}/Notes__${NOTES}/views`],
      [U, `${BASE}/base.json`],
      [U, `${FEATURES}/table.json`],
      [U, `${FEATURES}/records.jsonl`],
      [X, `${FEATURES}/views`],
    ])
    await world.account.push(world.hook, {
      changedTablesById: {
        [NOTES]: { changedMetadata: { current: { name: 'Ideas' }, previous: { name: 'Notes' } } },
      },
    })
    await world.account.push(world.hook, { destroyedTableIds: [FEATURES_ID] })
    await world.account.push(world.hook, records(NOTES))
    const next = await hook.pull(root(), delta.checkpoint)
    expect(pairs(next)).toEqual([
      [X, `${BASE}/Notes__${NOTES}`],
      [X, `${BASE}/Ideas__${NOTES}`],
      [U, `${BASE}/base.json`],
      [D, FEATURES],
      [U, `${BASE}/Ideas__${NOTES}/records.jsonl`],
      [X, `${BASE}/Ideas__${NOTES}/views`],
    ])
    expect((await calls(world)).filter((c) => c === `tables ${ROADMAP}`)).toHaveLength(1)
  })

  it('is UNKNOWN on the event root for lost payloads', async () => {
    const world = await worldOf()
    const hook = hookFor(world)
    const base = await hook.pull(root(), null)
    await world.account.push(world.hook, records())
    await world.account.push(world.hook, records())
    await world.account.expire(world.hook, 2)
    const delta = await hook.pull(root(), base.checkpoint)
    expect(pairs(delta)[0]).toEqual([X, '/at'])
    await world.account.push(world.hook, { error: true, code: 'INVALID_HOOK' })
    expect(pairs(await hook.pull(root(), delta.checkpoint))).toEqual([[X, '/at']])
  })

  it('loses a webhook that is gone and reads a new one from its start', async () => {
    const world = await worldOf()
    const hook = hookFor(world)
    const base = await hook.pull(root(), null)
    await world.account.dropWebhook(ROADMAP, world.hook)
    const made = await world.account.webhook(ROADMAP)
    await world.account.push(made, records())
    expect(pairs(await hook.pull(root(), base.checkpoint))).toEqual([
      [X, '/at'],
      [U, `${FEATURES}/records.jsonl`],
      [X, `${FEATURES}/views`],
    ])
  })

  it('loses the first payloads a new webhook let expire', async () => {
    const world = await worldOf()
    await world.account.push(world.hook, records())
    await world.account.push(world.hook, records())
    const hook = hookFor(world)
    const base = await hook.pull(root(), null)
    const made = await world.account.webhook(ROADMAP)
    await world.account.push(made, records())
    await world.account.push(made, records())
    await world.account.expire(made, 2)
    expect(pairs(await hook.pull(root(), base.checkpoint))).toEqual([
      [X, '/at'],
      [U, `${FEATURES}/records.jsonl`],
      [X, `${FEATURES}/views`],
    ])
  })

  it('follows bases that come and go', async () => {
    const world = await worldOf()
    const hook = hookFor(world)
    const base = await hook.pull(root(), null)
    await world.account.store(
      "DELETE FROM AirtableBase WHERE tenant = 'default' AND id = ?",
      ROADMAP,
    )
    await world.account.store(
      'INSERT INTO AirtableBase (tenant, id, name, permissionLevel, seq) ' +
        "VALUES ('default', ?, 'Ops', 'create', 2)",
      OPS,
    )
    expect(pairs(await hook.pull(root(), base.checkpoint))).toEqual([
      [X, `/at/bases/Ops__${OPS}`],
      [D, BASE],
    ])
  })

  it('lists no bases for a base root', async () => {
    const world = await worldOf()
    const hook = hookFor(world)
    const tableRoot = root(`bases/Roadmap__${ROADMAP}/Features__${FEATURES_ID}`)
    const start = await hook.pull(tableRoot, null)
    await world.account.push(world.hook, records())
    await world.account.push(world.hook, records(OTHER))
    await world.account.store(
      'INSERT INTO AirtableTable (tenant, id, baseId, name, primaryFieldId, seq) ' +
        "VALUES ('default', ?, ?, 'Other', 'fldOther000000001', 2)",
      OTHER,
      ROADMAP,
    )
    await world.account.store(
      'INSERT INTO AirtableField (tenant, id, tableId, name, type, seq) ' +
        "VALUES ('default', 'fldOther000000001', ?, 'Name', 'singleLineText', 2)",
      OTHER,
    )
    expect(pairs(await hook.pull(tableRoot, start.checkpoint))).toEqual([
      [U, `${FEATURES}/records.jsonl`],
      [X, `${FEATURES}/views`],
    ])
    expect(await calls(world)).not.toContain('bases')
  })

  it('reads nothing of a base the mount leaves out', async () => {
    const world = await worldOf()
    const hook = hookFor(world, { baseIds: [OPS] })
    const baseRoot = root(`bases/Roadmap__${ROADMAP}`)
    const base = await hook.pull(baseRoot, null)
    await world.account.push(world.hook, records())
    expect((await hook.pull(baseRoot, base.checkpoint)).changes).toEqual([])
    expect(await calls(world)).toEqual([])
  })

  it('names the tables of a base that lost payloads again', async () => {
    const world = await worldOf()
    const hook = hookFor(world)
    const base = await hook.pull(root(), null)
    await world.account.push(world.hook, {
      changedTablesById: { [FEATURES_ID]: { changedMetadata: { current: { name: 'Ideas' } } } },
    })
    await world.account.expire(world.hook, 2)
    await world.account.store(
      "UPDATE AirtableTable SET name = 'Ideas' WHERE tenant = 'default' AND id = ?",
      FEATURES_ID,
    )
    const delta = await hook.pull(root(), base.checkpoint)
    expect(pairs(delta)).toEqual([[X, '/at']])
    await world.account.push(world.hook, records())
    expect(pairs(await hook.pull(root(), delta.checkpoint))).toEqual([
      [U, `${BASE}/Ideas__${FEATURES_ID}/records.jsonl`],
      [X, `${BASE}/Ideas__${FEATURES_ID}/views`],
    ])
  })
})
