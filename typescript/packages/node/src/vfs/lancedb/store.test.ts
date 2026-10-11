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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connect } from '@lancedb/lancedb'
import { resolveLanceDBConfig } from '@struktoai/mirage-core/vfs/lancedb/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { LanceDBStore } from './store.ts'

const CAP = 5
const WIDE = 40

describe('lancedb store distinct', () => {
  let root = ''
  let store: LanceDBStore

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mirage-lancedb-'))
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < WIDE; i += 1) rows.push({ id: i, label: 'all' })
    rows.push(
      { id: WIDE, label: '' },
      { id: WIDE + 1, label: '.env' },
      { id: WIDE + 2, label: 'a∕x' },
    )
    const db = await connect(root)
    await db.createTable('crowded', rows)
    db.close()
    store = new LanceDBStore(
      resolveLanceDBConfig({
        uri: root,
        table: 'crowded',
        groupBy: ['label'],
        idColumn: 'id',
        titleColumn: 'label',
        maxRows: CAP,
      }),
    )
  })

  afterAll(async () => {
    await store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('caps the rows when no test is given', async () => {
    expect(await store.distinct('crowded', 'label', {}, CAP)).toEqual(['all'])
  })

  it('counts the values a test keeps, streamed past the head of the table', async () => {
    // The head of the table is all `all`, so a window over it never reaches
    // the values the test asks for; the scan runs until the cap is met.
    const lead = (value: string) => value === '' || value.startsWith('.')
    expect(await store.distinct('crowded', 'label', {}, CAP, '', lead)).toEqual(['', '.env'])
    const slashed = (value: string) => value.startsWith('a∕')
    expect(await store.distinct('crowded', 'label', {}, CAP, 'a', slashed)).toEqual(['a∕x'])
  })
})

// The store halves of the card search: which columns a filter on strings can
// test, and the rows a clause keeps.
describe('lancedb store card search', () => {
  let root = ''
  let store: LanceDBStore

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mirage-lancedb-'))
    const db = await connect(root)
    await db.createTable('plain', [
      { id: 1, name: 'a big orange cat', score: 1.5, live: true },
      { id: 2, name: 'a small grey cat', score: 2, live: false },
    ])
    await db.createTable('tagged', [{ id: 1, name: 'x', tags: ['orange'] }])
    db.close()
    store = new LanceDBStore(resolveLanceDBConfig({ uri: root, idColumn: 'id' }))
  })

  afterAll(async () => {
    await store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('names the string columns, and none past a list column', async () => {
    expect(await store.textColumns('plain', new Set())).toEqual(['name'])
    expect(await store.textColumns('tagged', new Set())).toBeNull()
    expect(await store.textColumns('tagged', new Set(['tags']))).toEqual(['name'])
  })

  it('returns the rows a clause keeps', async () => {
    const rows = await store.rowsWhere('plain', "`name` LIKE '%orange%'", ['id'])
    expect(rows.map((row) => Number(row.id))).toEqual([1])
  })
})
