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

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { PathSpec, type FileStat } from '../../types.ts'
import { ManualClock, runWithSystemClock } from '../../utils/clock.ts'
import { SqlVFS } from '../../vfs/sql/sql.ts'
import { SqlDialect, type SqlDriver, type SqlRow } from '../../vfs/sql/types.ts'
import { create } from './create.ts'
import { tokenOf } from './fingerprint.ts'
import { walk } from './path.ts'
import { write } from './write.ts'

const ENC = new TextEncoder()

// A SQLite database, in memory unless a file is named, as the inode tests
// read one. A failed batch rolls back whole, as a real driver's does, so a
// write the size guard refused can be retried on the same connection.
function memoryDriver(file = ':memory:'): SqlDriver {
  const db = new DatabaseSync(file)
  return {
    location: file,
    dialect: SqlDialect.SQLITE,
    exclusive: true,
    query: (sql, params = []) =>
      Promise.resolve(db.prepare(sql).all(...(params as SQLInputValue[])) as SqlRow[]),
    batch: (statements) => {
      db.exec('BEGIN')
      try {
        for (const s of statements) db.prepare(s.sql).run(...((s.params ?? []) as SQLInputValue[]))
      } catch (err) {
        db.exec('ROLLBACK')
        return Promise.reject(err instanceof Error ? err : new Error(String(err)))
      }
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

  it('moves on a rewrite through another driver on the same database', async () => {
    // Each driver keeps its own last stamp, so on a clock that stands still
    // only the file's own stored time keeps the second write past the first.
    const file = join(mkdtempSync(join(tmpdir(), 'fp-sql-')), 'db.sqlite')
    const first = new SqlVFS(memoryDriver(file), { ownsDriver: true })
    const second = new SqlVFS(memoryDriver(file), { ownsDriver: true })
    try {
      const [before, after] = await runWithSystemClock(new ManualClock(1_800_000_000), async () => {
        const at = PathSpec.fromStrPath('/f')
        await first.write(at, ENC.encode('one'))
        const was = await first.stat(at)
        await second.write(at, ENC.encode('two'))
        return [was, await first.stat(at)] as const
      })
      expect(before.fingerprint).not.toBe(after.fingerprint)
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('moves on a replacement over a file changed since its walk', async () => {
    // Both writes start from the same inode as the walk read it; the guard sends
    // the second back to the inode as it is, so it lands past the first instead
    // of on the same time. Mirrors Python's
    // test_a_replacement_over_a_file_changed_since_its_walk_moves_it.
    const file = join(mkdtempSync(join(tmpdir(), 'fp-sql-')), 'db.sqlite')
    const first = new SqlVFS(memoryDriver(file), { ownsDriver: true })
    const second = new SqlVFS(memoryDriver(file), { ownsDriver: true })
    try {
      const [theirs, ours] = await runWithSystemClock(new ManualClock(1_800_000_000), async () => {
        const at = PathSpec.fromStrPath('/f')
        await first.write(at, ENC.encode('one'))
        const read = await walk(first.accessor, at)
        await second.write(at, ENC.encode('two'))
        const was = await first.stat(at)
        await write(first.accessor, at, ENC.encode('six'), false, false, read)
        return [was, await first.stat(at)] as const
      })
      expect(theirs.fingerprint).not.toBe(ours.fingerprint)
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('moves on a create over a file another driver wrote', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fp-sql-')), 'db.sqlite')
    const first = new SqlVFS(memoryDriver(file), { ownsDriver: true })
    const second = new SqlVFS(memoryDriver(file), { ownsDriver: true })
    try {
      const [before, after] = await runWithSystemClock(new ManualClock(1_800_000_000), async () => {
        const at = PathSpec.fromStrPath('/f')
        await first.write(at, new Uint8Array(0))
        const was = await first.stat(at)
        await create(second.accessor, at)
        return [was, await first.stat(at)] as const
      })
      expect(before.fingerprint).not.toBe(after.fingerprint)
    } finally {
      await first.close()
      await second.close()
    }
  })
})
