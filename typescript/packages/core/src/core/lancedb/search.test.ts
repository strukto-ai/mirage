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

import { expect, it } from 'vitest'

import { LanceDBAccessor } from '../../accessor/lancedb.ts'
import { LANCEDB_COMMANDS } from '../../commands/builtin/lancedb/index.ts'
import { resolveLanceDBConfig } from '../../vfs/lancedb/config.ts'
import { PathSpec } from '../../types.ts'
import { searchRowsOutput } from '../vector/search.ts'
import { filesContaining } from './search.ts'
import type { LanceDriver } from './types.ts'
import { TREE } from './tree.ts'

it('spells a group value in the canonical path the way the listing does', async () => {
  // A path the listing never shows is one `cat` cannot open: the group
  // segment renders the way readdir renders it, escape lead and all.
  const config = resolveLanceDBConfig({
    uri: '/tmp/db',
    groupBy: ['label'],
    idColumn: 'id',
    titleColumn: 'name',
  })
  const driver = {
    search: () =>
      Promise.resolve([
        { id: 1, label: 'a/b', name: 'one', _distance: 0.1 },
        { id: 2, label: '', name: 'two', _distance: 0.2 },
        { id: 3, label: '.env', name: 'three', _distance: 0.3 },
      ]),
  } as unknown as LanceDriver
  const accessor = new LanceDBAccessor(driver, config)
  const path = new PathSpec({ virtual: '/db/docs', directory: '/db/docs', vfsPath: 'docs' })
  const output = (await searchRowsOutput(TREE, accessor, 'one', [path], 3, 0, '/db'))
    .map(([, record]) => record)
    .join('\n')
  const headers = output.split('\n').filter((line) => line.startsWith('/db/'))
  expect(headers).toEqual([
    '/db/docs/a∕b/1.md:0.1000',
    '/db/docs/⁄/2.md:0.2000',
    '/db/docs/⁄.env/3.md:0.3000',
  ])
})

it.each([
  [[], {}, 'search: query is required'],
  [[''], {}, 'search: query is required'],
  [['dog'], { method: 'hybrid' }, "search: only the 'semantic' method is supported"],
  [['dog'], { top_k: '0' }, 'search: top-k must be positive'],
])('refuses %j %j as a usage error', async (texts, flags, message) => {
  const cmd = LANCEDB_COMMANDS.find((c) => c.name === 'search')
  if (cmd === undefined) throw new Error('search not registered')
  const accessor = new LanceDBAccessor({} as LanceDriver, resolveLanceDBConfig({ uri: '/tmp/db' }))
  const opts = { stdin: null, flags, cwd: PathSpec.fromStrPath('/') }
  await expect(cmd.fn(accessor, [], texts, opts)).rejects.toMatchObject({ exitCode: 2, message })
})

const ANIMALS = [
  { id: 1, label: 'cat', kind: 'big', name: 'a big orange cat' },
  { id: 2, label: 'cat', kind: 'small', name: 'a small grey cat' },
  { id: 3, label: 'dog', kind: 'big', name: 'a big brown dog' },
]

// A driver over one table whose rowsWhere answers by substring on the string
// columns, recording every clause it is asked.
function animals(texts: string[] | null): { accessor: LanceDBAccessor; clauses: string[] } {
  const clauses: string[] = []
  const driver = {
    listTables: () => Promise.resolve(['animals']),
    tableColumns: () => Promise.resolve(['id', 'label', 'kind', 'name', 'vector']),
    textColumns: () => Promise.resolve(texts),
    rowsWhere: (_table: string, clause: string) => {
      clauses.push(clause)
      const wanted = /LIKE '%([^%]*)%'/.exec(clause)?.[1] ?? ''
      const fold = clause.includes('lower(')
      const group = /`kind` = '([^']*)'|`label` = '([^']*)'/.exec(clause)
      return Promise.resolve(
        ANIMALS.filter(
          (row) =>
            ['label', 'kind', 'name'].some((c) =>
              (fold
                ? String(row[c as keyof typeof row]).toLowerCase()
                : String(row[c as keyof typeof row])
              ).includes(wanted),
            ) &&
            (group === null || row.label === group[2] || row.kind === group[1]),
        ),
      )
    },
  } as unknown as LanceDriver
  const config = resolveLanceDBConfig({
    uri: '/tmp/db',
    groupBy: ['label', 'kind'],
    idColumn: 'id',
    titleColumn: 'name',
    vectorColumn: 'vector',
  })
  return { accessor: new LanceDBAccessor(driver, config), clauses }
}

function scope(virtual = '/db'): PathSpec {
  const vfsPath = virtual.replace(/^\/db\/?/, '')
  return new PathSpec({ virtual, directory: virtual, vfsPath })
}

// Twins of the files_containing tests in python/tests/core/lancedb/test_search.py.
it('names the cards a string column holds the text in', async () => {
  const { accessor } = animals(['label', 'kind', 'name'])
  const cards = async (text: string, under: PathSpec, ignoreCase = false) =>
    (await filesContaining(accessor, text, [under], false, ignoreCase))?.map((p) => p.virtual)
  expect(await cards('orange', scope())).toEqual(['/db/animals/cat/big/1.md'])
  expect(await cards('ORANGE', scope(), true)).toEqual(['/db/animals/cat/big/1.md'])
  expect(await cards('big', scope('/db/animals/dog'))).toEqual(['/db/animals/dog/big/3.md'])
  expect(await cards('nowhere', scope())).toEqual([])
})

it.each(['name', 'abe', 'kind', 'true', ' big', 'or4nge'])(
  'leaves %j to the scan',
  async (text) => {
    const { accessor, clauses } = animals(['label', 'kind', 'name'])
    expect(await filesContaining(accessor, text, [scope()], false, false)).toBeNull()
    expect(clauses).toEqual([])
  },
)

it('reads every card when a rendered column is a list or a struct', async () => {
  const { accessor } = animals(null)
  expect(await filesContaining(accessor, 'plain', [scope()], false, false)).toBeNull()
})

// Twin of test_card_labels_and_durations_read_every_card: every card spells its
// columns' names and the blob line's extension.
it('leaves a text a column name or the blob extension holds to the scan', async () => {
  const driver = {
    listTables: () => Promise.resolve(['t']),
    tableColumns: () => Promise.resolve(['id', 'owner name', 'payload']),
    textColumns: () => Promise.resolve(['owner name']),
    rowsWhere: () => Promise.resolve([{ id: 1 }]),
  } as unknown as LanceDriver
  const accessor = (blob: string | null) =>
    new LanceDBAccessor(
      driver,
      resolveLanceDBConfig({
        uri: '/tmp/db',
        table: 't',
        idColumn: 'id',
        ...(blob !== null ? { blobColumn: blob } : {}),
      }),
    )
  const named = accessor(null)
  expect(
    (await filesContaining(named, 'Jane', [scope()], false, false))?.map((p) => p.virtual),
  ).toEqual(['/db/1.md'])
  expect(await filesContaining(named, 'owner', [scope()], true, false)).toBeNull()
  expect(await filesContaining(named, 'ner na', [scope()], false, false)).toBeNull()
  expect(await filesContaining(accessor('payload'), 'bin', [scope()], false, false)).toBeNull()
})

// Twin of test_a_blob_title_is_searched: a title drawn from the blob column is
// a card line like any other, so the search keeps that column.
it('searches a title drawn from the blob column', async () => {
  const asked: string[][] = []
  const driver = {
    listTables: () => Promise.resolve(['t']),
    tableColumns: () => Promise.resolve(['id', 'body', 'name']),
    textColumns: (_table: string, skipped: ReadonlySet<string>) => {
      const texts = ['body', 'name'].filter((c) => !skipped.has(c))
      asked.push(texts)
      return Promise.resolve(texts)
    },
    rowsWhere: () => Promise.resolve([{ id: 1 }]),
  } as unknown as LanceDriver
  const config = resolveLanceDBConfig({
    uri: '/tmp/db',
    table: 't',
    idColumn: 'id',
    blobColumn: 'body',
    titleColumn: 'body',
  })
  const found = await filesContaining(
    new LanceDBAccessor(driver, config),
    'orange',
    [scope()],
    false,
    false,
  )
  expect(found?.map((p) => p.virtual)).toEqual(['/db/1.md'])
  expect(asked).toEqual([['body', 'name']])
})

// Twin of test_more_hits_than_a_listing_shows_read_every_card: a listing shows
// maxRows cards, so a text more rows hold reads the listed cards rather than
// fetching rows the walk never reaches.
it('reads every card when more rows hold the text than a listing shows', async () => {
  const rows = [0, 1, 2, 3, 4].map((id) => ({ id }))
  const driver = {
    listTables: () => Promise.resolve(['t']),
    tableColumns: () => Promise.resolve(['id', 'name']),
    textColumns: () => Promise.resolve(['name']),
    rowsWhere: (_table: string, _clause: string, _columns: string[], limit: number) =>
      Promise.resolve(rows.slice(0, limit)),
  } as unknown as LanceDriver
  const capped = (maxRows: number) =>
    new LanceDBAccessor(
      driver,
      resolveLanceDBConfig({ uri: '/tmp/db', table: 't', idColumn: 'id', maxRows }),
    )
  expect(await filesContaining(capped(4), 'plain', [scope()], false, false)).toBeNull()
  const found = await filesContaining(capped(5), 'plain', [scope()], false, false)
  expect(found?.map((p) => p.virtual)).toEqual(rows.map(({ id }) => `/db/${String(id)}.md`))
})
