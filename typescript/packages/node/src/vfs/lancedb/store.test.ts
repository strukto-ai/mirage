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

import { LanceDBStore, predicate } from './store.ts'

describe('lancedb where clause', () => {
  it('narrows on a name prefix, cast so a numeric id column takes one', () => {
    expect(predicate('id', {}, 'doc-1')).toBe("CAST(`id` AS STRING) LIKE 'doc-1%' ESCAPE '\\'")
  })

  it('escapes LIKE metacharacters in the prefix', () => {
    // An unescaped `_` is LIKE's single-character wildcard, so docX1 would
    // ride along and could crowd a real match out of the row cap.
    expect(predicate('id', {}, 'doc_')).toBe("CAST(`id` AS STRING) LIKE 'doc\\_%' ESCAPE '\\'")
    expect(predicate('id', {}, 'a%')).toBe("CAST(`id` AS STRING) LIKE 'a\\%%' ESCAPE '\\'")
  })

  it('ands the group filters with the prefix', () => {
    expect(predicate('id', { label: 'cat' }, 'doc-1')).toBe(
      "`label` = 'cat' AND CAST(`id` AS STRING) LIKE 'doc-1%' ESCAPE '\\'",
    )
  })

  it('quotes a column name a bare word could not spell', () => {
    // A space or a reserved word only parses quoted, and lance reads a
    // double-quoted word as a string literal, so the quotes are backticks.
    expect(predicate('document id', { select: 'cat' }, 'doc-1')).toBe(
      "`select` = 'cat' AND CAST(`document id` AS STRING) LIKE 'doc-1%' ESCAPE '\\'",
    )
  })

  it('is the filters alone with no prefix, and empty with neither', () => {
    expect(predicate('id', { label: 'cat' }, '')).toBe("`label` = 'cat'")
    expect(predicate('id', {}, '')).toBe('')
    expect(predicate('', {}, 'doc-1')).toBe('')
  })
})

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
