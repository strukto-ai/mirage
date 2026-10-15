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

import { mountKey } from '../../utils/key_prefix.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client.ts', () => ({
  countRows: vi.fn(),
  estimateSize: vi.fn(),
  fetchRows: vi.fn(),
  fetchBoundedRows: vi.fn(),
  fetchRowKey: vi.fn(),
  fetchColumns: vi.fn(),
  fetchLastRows: vi.fn(),
  fetchRowsAfter: vi.fn(),
  // A read proves the entity directory first, through the guards stat runs,
  // so the catalog those guards consult is faked too.
  listSchemas: vi.fn(),
  listTables: vi.fn(),
  listViews: vi.fn(),
  listMatviews: vi.fn(),
}))

vi.mock('./_schema_json.ts', () => ({
  buildDatabaseJson: vi.fn(),
  buildEntitySchemaJson: vi.fn(),
}))

import { PostgresAccessor } from '../../accessor/postgres.ts'
import { PathSpec } from '../../types.ts'
import { resolvePostgresConfig } from '../../vfs/postgres/config.ts'
import type { PgDriver } from './_driver.ts'
import * as client from './client.ts'
import * as _schema from './_schema_json.ts'
import { firstLines, follow, lastLines, lineCount, read, readStream, rowLine } from './read.ts'

const STUB_DRIVER: PgDriver = {
  query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  close: () => Promise.resolve(),
}

function makeAccessor(
  cfgOverrides: Parameters<typeof resolvePostgresConfig>[0] = { dsn: 'postgres://h/db' },
): PostgresAccessor {
  const cfg = resolvePostgresConfig(cfgOverrides)
  return new PostgresAccessor(STUB_DRIVER, cfg)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('read', () => {
  beforeEach(() => {
    vi.mocked(client.estimateSize).mockReset()
    vi.mocked(client.fetchBoundedRows).mockReset()
    vi.mocked(client.fetchRows).mockReset()
    vi.mocked(_schema.buildDatabaseJson).mockReset()
    vi.mocked(_schema.buildEntitySchemaJson).mockReset()
    // `listSchemas`'s contract over a catalog holding two schemas.
    vi.mocked(client.listSchemas).mockImplementation((_accessor, allow) =>
      Promise.resolve(['public', 'secret'].filter((s) => allow == null || allow.includes(s))),
    )
    vi.mocked(client.listTables).mockResolvedValue(['users'])
    vi.mocked(client.listViews).mockResolvedValue([])
    vi.mocked(client.listMatviews).mockResolvedValue([])
  })

  it('serializes database.json with 2-space indent', async () => {
    vi.mocked(_schema.buildDatabaseJson).mockResolvedValue({
      database: 'db',
      schemas: ['public'],
      tables: [],
      views: [],
      relationships: [],
    })
    const out = await read(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/database.json',
        directory: '/pg/',
        vfsPath: mountKey('/pg/database.json', '/pg'),
      }),
    )
    const parsed = JSON.parse(decode(out)) as { database: string }
    expect(parsed.database).toBe('db')
    expect(decode(out)).toContain('\n  ')
  })

  it('serializes entity schema.json with kind=table for tables/', async () => {
    vi.mocked(_schema.buildEntitySchemaJson).mockResolvedValue({
      schema: 'public',
      name: 'users',
      kind: 'table',
      columns: [],
      primary_key: [],
      foreign_keys: [],
      indexes: [],
      row_count_estimate: 0,
      size_bytes_estimate: 0,
    })
    await read(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/tables/users/schema.json',
        directory: '/pg/public/tables/users/',
        vfsPath: mountKey('/pg/public/tables/users/schema.json', '/pg'),
      }),
    )
    expect(_schema.buildEntitySchemaJson).toHaveBeenCalledWith(
      expect.anything(),
      'public',
      'users',
      'table',
    )
  })

  it('throws size-guard error when EXPLAIN exceeds rows threshold', async () => {
    vi.mocked(client.estimateSize).mockResolvedValue([20_000, 100])
    await expect(
      read(
        makeAccessor({ dsn: 'postgres://h/db', maxReadRows: 10_000, maxReadBytes: 1_000_000 }),
        new PathSpec({
          virtual: '/pg/public/tables/users/rows.jsonl',
          directory: '/pg/public/tables/users/',
          vfsPath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'EFBIG', virtualPath: '/pg/public/tables/users/rows.jsonl' })
  })

  it('returns JSONL bytes when row count under threshold', async () => {
    vi.mocked(client.estimateSize).mockResolvedValue([2, 64])
    vi.mocked(client.fetchBoundedRows).mockResolvedValue([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    const out = await read(
      makeAccessor({ dsn: 'postgres://h/db', maxReadRows: 10_000, maxReadBytes: 1_000_000 }),
      new PathSpec({
        virtual: '/pg/public/tables/users/rows.jsonl',
        directory: '/pg/public/tables/users/',
        vfsPath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
      }),
    )
    expect(decode(out)).toBe('{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n')
  })

  it('honors explicit limit/offset and bypasses size guard', async () => {
    vi.mocked(client.fetchRows).mockResolvedValue([{ id: 99 }])
    await read(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/tables/users/rows.jsonl',
        directory: '/pg/public/tables/users/',
        vfsPath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
      }),
      undefined,
      { limit: 10, offset: 5 },
    )
    expect(client.fetchRows).toHaveBeenCalledWith(expect.anything(), 'public', 'users', {
      limit: 10,
      offset: 5,
    })
    expect(client.estimateSize).not.toHaveBeenCalled()
  })

  it('serializes Date values as ISO strings', async () => {
    vi.mocked(client.estimateSize).mockResolvedValue([1, 64])
    vi.mocked(client.fetchBoundedRows).mockResolvedValue([
      { ts: new Date('2026-04-30T00:00:00.000Z') },
    ])
    const out = await read(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/tables/users/rows.jsonl',
        directory: '/pg/public/tables/users/',
        vfsPath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
      }),
    )
    expect(decode(out)).toBe('{"ts":"2026-04-30T00:00:00.000Z"}\n')
  })

  // `schemas` hid the schema from `ls` while `cat` of a table under it fetched
  // its rows: the read addressed the database by the names in the path and
  // never asked whether the mount could see them.
  it('refuses a table under a schema outside schemas', async () => {
    vi.mocked(client.estimateSize).mockResolvedValue([1, 10])
    vi.mocked(client.fetchBoundedRows).mockResolvedValue([{ id: 1 }])
    const accessor = makeAccessor({ dsn: 'postgres://h/db', schemas: ['public'] })
    for (const name of ['rows.jsonl', 'schema.json']) {
      await expect(
        read(
          accessor,
          new PathSpec({
            virtual: `/pg/secret/tables/users/${name}`,
            directory: '/pg/secret/tables/users/',
            vfsPath: mountKey(`/pg/secret/tables/users/${name}`, '/pg'),
          }),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(client.fetchBoundedRows).not.toHaveBeenCalled()
    expect(_schema.buildEntitySchemaJson).not.toHaveBeenCalled()
    const out = await read(
      accessor,
      new PathSpec({
        virtual: '/pg/public/tables/users/rows.jsonl',
        directory: '/pg/public/tables/users/',
        vfsPath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
      }),
    )
    expect(decode(out)).toBe('{"id":1}\n')
  })

  // The estimate is planner statistics and lags the table; it used to be the
  // LIMIT, so a table loaded since the last ANALYZE read back as only the rows
  // the statistics knew about.
  it('does not truncate a whole read to a stale estimate', async () => {
    const table = Array.from({ length: 40 }, (_, id) => ({ id }))
    vi.mocked(client.estimateSize).mockResolvedValue([2, 10])
    vi.mocked(client.fetchBoundedRows).mockImplementation((_a, _s, _e, window) =>
      Promise.resolve(table.slice(0, window.limit)),
    )
    const out = await read(
      makeAccessor({ dsn: 'postgres://h/db', maxReadRows: 100 }),
      new PathSpec({
        virtual: '/pg/public/tables/users/rows.jsonl',
        directory: '/pg/public/tables/users/',
        vfsPath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
      }),
    )
    expect(decode(out).trim().split('\n')).toHaveLength(40)
  })

  it('refuses a table the estimate undercounted on the rows it has', async () => {
    const table = Array.from({ length: 40 }, (_, id) => ({ id }))
    vi.mocked(client.estimateSize).mockResolvedValue([2, 10])
    vi.mocked(client.fetchBoundedRows).mockImplementation((_a, _s, _e, window) =>
      Promise.resolve(table.slice(0, window.limit)),
    )
    await expect(
      read(
        makeAccessor({ dsn: 'postgres://h/db', maxReadRows: 10 }),
        new PathSpec({
          virtual: '/pg/public/tables/users/rows.jsonl',
          directory: '/pg/public/tables/users/',
          vfsPath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'EFBIG', virtualPath: '/pg/public/tables/users/rows.jsonl' })
    expect(vi.mocked(client.fetchBoundedRows).mock.calls[0]?.[3]).toEqual({
      limit: 11,
      maxBytes: 10 * 1024 * 1024,
    })
  })
})

describe('whole-read byte budget', () => {
  it('refuses a server-side overflow without using the unbounded fetch', async () => {
    vi.mocked(client.estimateSize).mockResolvedValue([1, 10])
    vi.mocked(client.fetchBoundedRows).mockResolvedValue(null)
    vi.mocked(client.fetchRows).mockClear()
    await expect(
      read(
        makeAccessor({ dsn: 'postgres://h/db', maxReadBytes: 100 }),
        PathSpec.fromStrPath('/public/tables/users/rows.jsonl'),
      ),
    ).rejects.toMatchObject({ code: 'EFBIG', virtualPath: '/public/tables/users/rows.jsonl' })
    expect(client.fetchRows).not.toHaveBeenCalled()
  })

  it.each([10, 11])('checks rendered UTF-8 bytes at a budget of %i', async (maxReadBytes) => {
    vi.mocked(client.estimateSize).mockResolvedValue([1, 1])
    vi.mocked(client.fetchBoundedRows).mockResolvedValue([{ x: 'é' }])
    const result = read(
      makeAccessor({ dsn: 'postgres://h/db', maxReadBytes }),
      PathSpec.fromStrPath('/public/tables/users/rows.jsonl'),
    )
    if (maxReadBytes === 10) await expect(result).rejects.toMatchObject({ code: 'EFBIG' })
    else expect(decode(await result)).toBe('{"x":"é"}\n')
  })
})

// Twin of test_a_row_line_spells_numbers_as_typescript_does.
it('spells a row line number as JSON.stringify does', () => {
  const row = { a: 1e19, b: 0.00001, c: 3.4e38, d: { n: [1.5e-7, 2.0] } }
  expect(rowLine(row)).toBe(
    '{"a":10000000000000000000,"b":0.00001,"c":3.4e+38,"d":{"n":[1.5e-7,2]}}',
  )
})

describe('read stand-ins', () => {
  const ROWS = new PathSpec({
    virtual: '/public/tables/users/rows.jsonl',
    directory: '/public/tables/users/',
    vfsPath: 'public/tables/users/rows.jsonl',
  })

  function table(n: number): void {
    const rows = Array.from({ length: n }, (_, id) => ({ id }))
    vi.mocked(client.countRows).mockResolvedValue(n)
    vi.mocked(client.fetchRows).mockImplementation((_a, _s, _e, { limit, offset }) =>
      Promise.resolve(rows.slice(offset, offset + limit)),
    )
  }

  beforeEach(() => {
    vi.mocked(client.countRows).mockReset()
    vi.mocked(client.fetchRows).mockReset()
    vi.mocked(client.fetchRowKey).mockResolvedValue([])
    vi.mocked(client.fetchColumns).mockResolvedValue([
      { name: 'id', type: 'int4', nullable: false },
    ])
    vi.mocked(client.listSchemas).mockImplementation((_accessor, allow) =>
      Promise.resolve(['public', 'secret'].filter((s) => allow == null || allow.includes(s))),
    )
    vi.mocked(client.listTables).mockResolvedValue(['users'])
    vi.mocked(client.listViews).mockResolvedValue([])
    vi.mocked(client.listMatviews).mockResolvedValue([])
  })

  // `defaultRowLimit` clamped the pushed-down count, so `head -n 1200` of a
  // 1500-row table printed 1000 lines.
  it('takes every first row asked for past the default', async () => {
    table(1500)
    const out = decode((await firstLines(makeAccessor(), ROWS, 1200)) ?? new Uint8Array())
    expect(out.split('\n').filter((l) => l !== '')).toHaveLength(1200)
  })

  it('takes a short table whole past the ceiling and refuses a long one', async () => {
    const accessor = makeAccessor({ dsn: 'postgres://h/db', maxReadRows: 20 })
    table(15)
    const out = decode((await firstLines(accessor, ROWS, 25)) ?? new Uint8Array())
    expect(out.split('\n').filter((l) => l !== '')).toHaveLength(15)
    expect(vi.mocked(client.fetchRows).mock.calls[0]?.[3]).toEqual({ limit: 21, offset: 0 })
    table(30)
    await expect(firstLines(accessor, ROWS, 25)).rejects.toMatchObject({ code: 'EFBIG' })
  })

  it('takes the last rows by offset and refuses a suffix past the ceiling', async () => {
    table(1500)
    const out = decode((await lastLines(makeAccessor(), ROWS, 1200)) ?? new Uint8Array())
    const lines = out.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(1200)
    expect(lines.at(-1)).toBe('{"id":1499}')
    table(30)
    const capped = makeAccessor({ dsn: 'postgres://h/db', maxReadRows: 20 })
    await expect(lastLines(capped, ROWS, 25)).rejects.toMatchObject({ code: 'EFBIG' })
  })

  // Twin of test_last_lines_of_a_keyed_table_come_off_its_key.
  it("takes a keyed table's last rows off its key", async () => {
    vi.mocked(client.fetchRowKey).mockResolvedValue(['id'])
    vi.mocked(client.fetchLastRows).mockResolvedValue([[{ id: 8 }, { id: 9 }], [9]])
    expect(decode((await lastLines(makeAccessor(), ROWS, 2)) ?? new Uint8Array())).toBe(
      '{"id":8}\n{"id":9}\n',
    )
    expect(client.countRows).not.toHaveBeenCalled()
    expect(vi.mocked(client.fetchLastRows).mock.calls[0]?.slice(3)).toEqual([['id'], 2])
  })

  // Twin of test_a_keyed_table_streams_in_pages_up_to_its_ceiling.
  it('streams a keyed table in pages up to its ceiling', async () => {
    vi.mocked(client.fetchRowKey).mockResolvedValue(['id'])
    const after = vi
      .mocked(client.fetchRowsAfter)
      .mockResolvedValueOnce([[{ id: 1 }, { id: 2 }], [2]])
      .mockResolvedValueOnce([[{ id: 3 }, { id: 4 }], [4]])
    const accessor = makeAccessor({ dsn: 'postgres://h/db', maxReadRows: 3, defaultRowLimit: 2 })
    const got: string[] = []
    await expect(
      (async () => {
        for await (const chunk of readStream(accessor, ROWS)) got.push(decode(chunk))
      })(),
    ).rejects.toMatchObject({ code: 'EFBIG' })
    expect(got).toEqual(['{"id":1}\n{"id":2}\n', '{"id":3}\n'])
    // Each page asks past its last key for one row past what the row cap
    // leaves, within the bytes the byte cap leaves.
    expect(after.mock.calls.map((call) => [call[4], call[5], call[7]])).toEqual([
      [null, 2, 10 * 1024 * 1024],
      [[2], 2, 10 * 1024 * 1024 - 18],
    ])
  })

  // Twin of test_a_page_past_the_byte_cap_is_asked_again_smaller: the database
  // refuses a page past what the byte cap leaves before sending it; half the
  // page is asked next, so the rows that fit come out, and one row that does
  // not fit is the refusal.
  it('asks a page past the byte cap again smaller', async () => {
    vi.mocked(client.fetchRowKey).mockResolvedValue(['id'])
    const after = vi
      .mocked(client.fetchRowsAfter)
      .mockReset()
      .mockResolvedValueOnce([null, null])
      .mockResolvedValueOnce([[{ id: 1 }], [1]])
      .mockResolvedValueOnce([null, [1]])
    const got: string[] = []
    await expect(
      (async () => {
        for await (const chunk of readStream(
          makeAccessor({ dsn: 'postgres://h/db', defaultRowLimit: 2 }),
          ROWS,
        )) {
          got.push(decode(chunk))
        }
      })(),
    ).rejects.toMatchObject({ code: 'EFBIG' })
    expect(got).toEqual(['{"id":1}\n'])
    expect(after.mock.calls.map((call) => [call[4], call[5]])).toEqual([
      [null, 2],
      [null, 1],
      [[1], 1],
    ])
  })

  // Twin of test_a_followed_table_prints_rows_past_the_last_key.
  it('follows a keyed table past its last key', async () => {
    vi.mocked(client.fetchRowKey).mockResolvedValue(['id'])
    vi.mocked(client.fetchLastRows).mockResolvedValue([[{ id: 8 }, { id: 9 }], [9]])
    const after = vi
      .mocked(client.fetchRowsAfter)
      .mockReset()
      .mockResolvedValueOnce([[], [9]])
      .mockResolvedValueOnce([[{ id: 10 }], [10]])
    const lines = await follow(makeAccessor(), ROWS, 1, 0)
    if (lines === null) throw new Error('a keyed table is followed')
    const iterator = lines[Symbol.asyncIterator]()
    const got = [await iterator.next(), await iterator.next()].map((r) =>
      decode(r.value as Uint8Array),
    )
    await iterator.return?.()
    expect(got).toEqual(['{"id":9}\n', '{"id":10}\n'])
    expect(after.mock.calls.map((call) => call[4])).toEqual([[9], [9]])
  })

  // Twin of test_a_keyless_relation_is_not_followed.
  it('follows no keyless relation', async () => {
    expect(await follow(makeAccessor(), ROWS, 1, 0)).toBeNull()
  })

  it('counts rows past the ceiling', async () => {
    table(30)
    expect(await lineCount(makeAccessor({ dsn: 'postgres://h/db', maxReadRows: 20 }), ROWS)).toBe(
      30,
    )
  })

  it('leaves another file to the read and refuses a hidden schema', async () => {
    const schema = new PathSpec({
      virtual: '/public/tables/users/schema.json',
      directory: '/public/tables/users/',
      vfsPath: 'public/tables/users/schema.json',
    })
    expect(await firstLines(makeAccessor(), schema, 3)).toBeNull()
    expect(await lastLines(makeAccessor(), schema, 3)).toBeNull()
    expect(await lineCount(makeAccessor(), schema)).toBeNull()
    const hidden = new PathSpec({
      virtual: '/secret/tables/users/rows.jsonl',
      directory: '/secret/tables/users/',
      vfsPath: 'secret/tables/users/rows.jsonl',
    })
    const accessor = makeAccessor({ dsn: 'postgres://h/db', schemas: ['public'] })
    await expect(firstLines(accessor, hidden, 3)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lastLines(accessor, hidden, 3)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lineCount(accessor, hidden)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(client.countRows).not.toHaveBeenCalled()
  })
})
