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
import { PathSpec, type FileStat } from '../../types.ts'
import { ManualClock, runWithSystemClock } from '../../utils/clock.ts'
import { SqlVFS } from '../../vfs/sql/sql.ts'
import { SqlDialect, type SqlDriver, type SqlRow } from '../../vfs/sql/types.ts'
import { tokenOf } from './fingerprint.ts'

const ENC = new TextEncoder()

// A SQLite database in memory, as the inode tests read one.
function memoryDriver(): SqlDriver {
  const db = new DatabaseSync(':memory:')
  return {
    location: ':memory:',
    dialect: SqlDialect.SQLITE,
    exclusive: true,
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

async function rewritten(vfs: SqlVFS): Promise<[FileStat, FileStat, FileStat | undefined]> {
  const at = PathSpec.fromStrPath('/f')
  await vfs.write(at, ENC.encode('one'))
  const first = await vfs.stat(at)
  await vfs.write(at, ENC.encode('two'))
  const second = await vfs.stat(at)
  const tree = await vfs.readTree(PathSpec.fromStrPath('/'))
  return [first, second, tree?.get('f')]
}

describe('tokenOf', () => {
  it('names the inode and the nanosecond', () => {
    expect(tokenOf(7, 1_800_000_000, 5)).toBe('7:1800000000.000000005')
  })

  it('moves on a same-size rewrite on a clock that stands still', async () => {
    const vfs = new SqlVFS(memoryDriver(), { ownsDriver: true })
    try {
      const [first, second, listed] = await runWithSystemClock(new ManualClock(1_800_000_000), () =>
        rewritten(vfs),
      )
      expect(first.fingerprint).not.toBe(second.fingerprint)
      expect(listed?.fingerprint).toBe(second.fingerprint)
    } finally {
      await vfs.close()
    }
  })
})
