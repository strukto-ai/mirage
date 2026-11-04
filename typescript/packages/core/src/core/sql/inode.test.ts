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
import { FileType } from '../../types.ts'
import { SqlDialect, type SqlDriver, type SqlRow } from '../../vfs/sql/types.ts'
import { MAX_PARAMS } from './constants.ts'
import { byEntry, byIno, inodeStat, insertRows, isoOf, stampOf, type Inode } from './inode.ts'

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

function node(mode: number, uid = 0): Inode {
  return {
    ino: 2,
    mode,
    nlink: 1,
    uid,
    gid: 0,
    size: 3,
    atime: 0,
    atimeNsec: 0,
    mtime: 1_700_000_000,
    mtimeNsec: 123_000_000,
    ctime: 0,
    ctimeNsec: 0,
  }
}

describe('inode', () => {
  it('round-trips a stamp to the microsecond', () => {
    expect(stampOf('2023-11-14T22:13:20.123456Z')).toEqual([1_700_000_000, 123_456_000])
    expect(isoOf(1_700_000_000, 123_456_000)).toBe('2023-11-14T22:13:20.123456Z')
    expect(isoOf(1_700_000_000, 0)).toBe('2023-11-14T22:13:20Z')
  })

  it('stats an inode as its kind, owner 0 as none', () => {
    const file = inodeStat('/d/a.txt', node(0o100640))
    expect([file.name, file.type, file.size, file.mode, file.uid]).toEqual([
      'a.txt',
      FileType.FILE,
      3,
      0o640,
      null,
    ])
    expect(file.modified).toBe('2023-11-14T22:13:20.123000Z')
    const folder = inodeStat('/d', node(0o40755, 1000))
    expect([folder.type, folder.size, folder.uid]).toEqual([FileType.DIRECTORY, null, 1000])
  })

  it('nests an entry ref under its parent', () => {
    const ref = byEntry(byEntry(byIno(1), 'a'), 'b')
    expect(ref.params).toEqual(['a', 'b'])
    expect(ref.sql.split('SELECT ino FROM fs_dentry').length - 1).toBe(2)
  })

  it('splits rows where a statement would bind too many', () => {
    const rows = Array.from({ length: MAX_PARAMS }, (_, i) => [i, new Uint8Array(1)])
    const statements = insertRows('INSERT INTO t (a, b)', '(?, ?)', rows)
    expect(statements.every((s) => (s.params ?? []).length <= MAX_PARAMS)).toBe(true)
    expect(statements.reduce((n, s) => n + (s.params ?? []).length, 0)).toBe(2 * MAX_PARAMS)
  })

  it('starts a fresh database with the root alone', async () => {
    const driver = memoryDriver()
    const accessor = new SqlAccessor(driver)
    await accessor.chunkSize()
    expect(await accessor.query('SELECT ino, mode, nlink FROM fs_inode')).toEqual([
      { ino: 1, mode: 0o40755, nlink: 1 },
    ])
    await driver.close()
  })
})
