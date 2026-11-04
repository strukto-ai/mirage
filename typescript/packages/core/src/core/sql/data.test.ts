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

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SqlAccessor } from '../../accessor/sql.ts'
import { SqlDialect, type SqlDriver, type SqlRow } from '../../vfs/sql/types.ts'
import { FILE } from './constants.ts'
import { cutBytes, placeBytes, readBytes } from './data.ts'
import { byIno, type Inode } from './inode.ts'

const enc = new TextEncoder()

// A SQLite database in this process, as the ops reach one.
function memoryDriver(): SqlDriver {
  const db = new DatabaseSync(':memory:')
  return {
    location: ':memory:',
    dialect: SqlDialect.SQLITE,
    query: (sql, params = []) =>
      Promise.resolve(db.prepare(sql).all(...(params as SQLInputValue[])) as SqlRow[]),
    batch: (statements) => {
      db.exec('BEGIN')
      for (const s of statements) db.prepare(s.sql).run(...((s.params ?? []) as SQLInputValue[]))
      db.exec('COMMIT')
      return Promise.resolve()
    },
    close: () => {
      db.close()
      return Promise.resolve()
    },
  }
}

async function accessorAt(chunkSize: number): Promise<SqlAccessor> {
  const driver = memoryDriver()
  await driver.batch([
    { sql: 'CREATE TABLE fs_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)' },
    { sql: "INSERT INTO fs_config VALUES ('chunk_size', ?)", params: [String(chunkSize)] },
  ])
  const accessor = new SqlAccessor(driver)
  expect(await accessor.chunkSize()).toBe(chunkSize)
  return accessor
}

function file(size: number): Inode {
  return { ino: 7, mode: FILE, size, mtime: 0, mtimeNsec: 0 }
}

async function rows(accessor: SqlAccessor): Promise<string[]> {
  const found = await accessor.query('SELECT data FROM fs_data WHERE ino = 7 ORDER BY chunk_index')
  return found.map((r) => new TextDecoder().decode(r.data as Uint8Array))
}

describe('data', () => {
  it('reads a sparse file’s holes as zeros', async () => {
    const accessor = await accessorAt(4)
    await accessor.batch(await placeBytes(accessor, byIno(7), null, 8, enc.encode('zz')))
    expect(await readBytes(accessor, file(12))).toEqual(
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 122, 122, 0, 0]),
    )
    expect(await readBytes(accessor, file(12), 7, 2)).toEqual(new Uint8Array([0, 122]))
  })

  it('keeps the bytes a write’s edge rows held', async () => {
    const accessor = await accessorAt(4)
    await accessor.batch(await placeBytes(accessor, byIno(7), null, 0, enc.encode('abcdefghij')))
    await accessor.batch(await placeBytes(accessor, byIno(7), file(10), 3, enc.encode('XYZ')))
    expect(await rows(accessor)).toEqual(['abcX', 'YZgh', 'ij'])
  })

  it('drops the rows past a cut and trims the last', async () => {
    const accessor = await accessorAt(4)
    await accessor.batch(await placeBytes(accessor, byIno(7), null, 0, enc.encode('abcdefghij')))
    await accessor.batch(await cutBytes(accessor, file(10), 5))
    expect(await rows(accessor)).toEqual(['abcd', 'e'])
    expect(await cutBytes(accessor, file(5), 9)).toEqual([])
  })
})
