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

import { MountMode } from '@struktoai/mirage-core/types'
import { SqlVFS } from '@struktoai/mirage-core/vfs/sql/sql'
import { SqlWorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/sql'
import { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ObjectStorage, sqliteWasm } from '../../tests/object_storage.ts'
import { DurableObjectPagedSqlDriver, type PagedSqlOptions } from './driver.ts'

const wasm = sqliteWasm()
const decoder = new TextDecoder()

function open(
  storage: ObjectStorage,
  options: PagedSqlOptions = {},
): Promise<DurableObjectPagedSqlDriver> {
  return DurableObjectPagedSqlDriver.open(storage, { wasm, ...options })
}

// A workspace whose files and sessions live in `driver`, as a host builds one.
async function lines(driver: DurableObjectPagedSqlDriver, run: readonly string[]): Promise<string> {
  const ws = new Workspace(
    { '/s': new SqlVFS(driver) },
    {
      mode: MountMode.EXEC,
      workspaceId: 'paged',
      store: new SqlWorkspaceStateStore(driver, { scope: 'paged' }),
      ownsStore: true,
    },
  )
  try {
    let out = ''
    for (const line of run) {
      const result = await ws.shell(line)
      out += decoder.decode(result.stdout) + decoder.decode(result.stderr)
    }
    return out
  } finally {
    await ws.close()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the paged sql driver of a Durable Object', () => {
  it('keeps what was flushed across a reopen, and nothing written after', async () => {
    const storage = new ObjectStorage()
    const first = await open(storage)
    await lines(first, ['mkdir -p /s/p && cd /s/p && printf "b\\na\\n" > f'])
    first.flush()
    await lines(first, ['printf lost > /s/p/g'])
    const second = await open(storage.restarted())
    expect(await lines(second, ['pwd && sort f', 'ls /s/p'])).toBe('/s/p\na\nb\nf\n')
  })

  it('writes a few rows of the storage for many of the mount', async () => {
    const storage = new ObjectStorage()
    const driver = await open(storage)
    await lines(driver, [
      'mkdir /s/d && for i in $(seq 1 300); do head -c 6000 /dev/zero > /s/d/f$i; done',
    ])
    const [files] = await driver.query('SELECT count(*) AS n FROM fs_data')
    expect(Number(files?.n)).toBeGreaterThanOrEqual(600)
    expect(driver.flush()).toBeLessThanOrEqual(3)
    expect(storage.rowsWritten).toBeLessThanOrEqual(3)
    expect(driver.flush()).toBe(0)
    await driver.close()
    expect(await lines(await open(storage), ['ls /s/d | wc -l', 'wc -c < /s/d/f300'])).toBe(
      '300\n6000\n',
    )
  })

  it('keeps the last flush when the storage fails in the middle of the next', async () => {
    const storage = new ObjectStorage()
    const driver = await open(storage)
    await lines(driver, ['printf kept > /s/a'])
    driver.flush()
    await lines(driver, ['head -c 3000000 /dev/zero > /s/big'])
    storage.writesLeft = 1
    expect(() => driver.flush()).toThrow('the storage refused a write')
    const again = await open(storage.restarted())
    expect(await lines(again, ['ls /s', 'cat /s/a'])).toBe('a\nkept')
  })

  it('fails the statement when the storage refuses a row written ahead of a flush', async () => {
    const storage = new ObjectStorage()
    const driver = await open(storage, { spillBytes: 65536 })
    await driver.query('CREATE TABLE t (a INTEGER PRIMARY KEY, b BLOB)')
    driver.flush()
    storage.writesLeft = 0
    const insert = async (): Promise<void> => {
      await driver.query('INSERT INTO t (a, b) VALUES (?, ?)', [1, new Uint8Array(3 << 20)])
    }
    await expect(insert).rejects.toThrow('INSERT INTO t (a, b) VALUES (?, ?): the storage refused')
    await expect(async () => {
      await driver.query('SELECT count(*) AS n FROM t')
    }).rejects.toThrow('the storage refused a write')
    const again = await open(storage.restarted())
    expect(await again.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }])
  })

  it('holds a storage alone until it is closed', async () => {
    const storage = new ObjectStorage()
    const driver = await open(storage)
    await expect(open(storage)).rejects.toThrow('already open on this storage')
    await driver.query('CREATE TABLE t (a INTEGER PRIMARY KEY)')
    await driver.close()
    await expect(async () => {
      await driver.query('SELECT 1')
    }).rejects.toThrow('the paged database is closed')
    const next = await open(storage)
    expect(await next.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }])
    await driver.close()
    await expect(open(storage)).rejects.toThrow('already open on this storage')
  })

  it('binds a statement run again with fewer parameters to NULL, not to the last values', async () => {
    const driver = await open(new ObjectStorage())
    driver.sql.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b BLOB)')
    driver.sql.exec('INSERT INTO t (a, b) VALUES (?, ?)', 1, new Uint8Array([7]))
    driver.sql.exec('INSERT INTO t (a, b) VALUES (?, ?)', 2)
    expect(driver.sql.exec('SELECT a, b FROM t ORDER BY a').toArray()).toEqual([
      { a: 1, b: new Uint8Array([7]) },
      { a: 2, b: null },
    ])
  })

  it("runs a host's own tables in the database inside", async () => {
    const storage = new ObjectStorage()
    const driver = await open(storage)
    driver.sql.exec('CREATE TABLE usage (id INTEGER PRIMARY KEY, bytes INTEGER, body BLOB)')
    driver.transactionSync(() => {
      driver.sql.exec('INSERT INTO usage (bytes, body) VALUES (?, ?)', 7, new Uint8Array([1, 2]))
      driver.sql.exec('INSERT INTO usage (bytes, body) VALUES (?, ?)', 2 ** 40, null)
    })
    expect(() =>
      driver.transactionSync(() => {
        driver.sql.exec('DELETE FROM usage')
        throw new Error('undone')
      }),
    ).toThrow('undone')
    await driver.close()
    const rows = (await open(storage)).sql.exec('SELECT bytes, body FROM usage ORDER BY id')
    expect(rows.toArray()).toEqual([
      { bytes: 7, body: new Uint8Array([1, 2]) },
      { bytes: 2 ** 40, body: null },
    ])
    expect(
      storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'usage'").toArray(),
    ).toEqual([])
  })

  it('runs a script one statement at a time, its last one taking the parameters', async () => {
    const driver = await open(new ObjectStorage())
    const rows = driver.sql.exec(
      'CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, NULL);; -- the last\n' +
        'SELECT a FROM t WHERE a = ? /* and no more */ ;\n',
      1,
    )
    expect(rows.toArray()).toEqual([{ a: 1 }])
    driver.sql.exec('INSERT INTO t VALUES (?, ?); ', 2, 'x')
    driver.sql.exec('INSERT INTO t VALUES (?, ?); ', 3, 'y')
    expect(driver.sql.exec('SELECT a, b FROM t ORDER BY a').toArray()).toEqual([
      { a: 1, b: null },
      { a: 2, b: 'x' },
      { a: 3, b: 'y' },
    ])
    expect(() => driver.sql.exec('DELETE FROM t; SELECT * FROM missing')).toThrow(
      'no such table: missing',
    )
    expect(driver.sql.exec('SELECT count(*) AS n FROM t').toArray()).toEqual([{ n: 0 }])
  })

  it('answers a text as it was bound, a NUL in it and a byte order mark before it too', async () => {
    const driver = await open(new ObjectStorage())
    driver.sql.exec('CREATE TABLE t (k INTEGER PRIMARY KEY, a TEXT)')
    const long = `${'x'.repeat(40)}\0y`
    const texts = ['a\0b', 'é😀', 'ab\udc80cd', long, '\ufeffmarked']
    texts.forEach((text, k) => driver.sql.exec('INSERT INTO t VALUES (?, ?)', k, text))
    const rows = driver.sql.exec('SELECT a FROM t ORDER BY k').toArray()
    expect(rows.map((row) => row.a)).toEqual(['a\0b', 'é😀', 'ab\ufffdcd', long, '\ufeffmarked'])
    expect(driver.sql.exec("SELECT 'é😀' AS a").toArray()).toEqual([{ a: 'é😀' }])
  })

  it('opens no database file beside its own', async () => {
    const driver = await open(new ObjectStorage())
    driver.sql.exec('CREATE TABLE t (a INTEGER)')
    expect(() => driver.sql.exec("ATTACH 'other.db' AS other")).toThrow('unable to open database')
    expect(() => driver.sql.exec("ATTACH 'main.db' AS again")).toThrow('unable to open database')
    driver.sql.exec("ATTACH ':memory:' AS scratch")
    driver.sql.exec('CREATE TABLE scratch.t (a INTEGER)')
    expect(driver.sql.exec('SELECT count(*) AS n FROM scratch.t').toArray()).toEqual([{ n: 0 }])
  })

  it('throws what failed a transaction SQLite rolled back by itself', async () => {
    const storage = new ObjectStorage()
    const driver = await open(storage, { spillBytes: 65536 })
    driver.sql.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b BLOB)')
    driver.sql.exec('INSERT INTO t (a) VALUES (1)')
    expect(() => {
      driver.transactionSync(() => {
        driver.sql.exec('INSERT OR ROLLBACK INTO t (a) VALUES (1)')
      })
    }).toThrow('UNIQUE constraint failed: t.a')
    driver.flush()
    storage.writesLeft = 0
    await expect(async () => {
      await driver.batch([
        { sql: 'INSERT INTO t (a, b) VALUES (?, ?)', params: [2, new Uint8Array(3 << 20)] },
      ])
    }).rejects.toThrow('COMMIT: the storage refused a write')
  })

  it('lets the event loop turn as statements carry file data, on one timer at a time', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0)
    const driver = await open(new ObjectStorage())
    await driver.query('CREATE TABLE t (a INTEGER PRIMARY KEY, b BLOB)')
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const blob = new Uint8Array(40000)
    const burst = Array.from({ length: 20000 }, (_, a) =>
      driver.query('INSERT INTO t (a, b) VALUES (?, ?)', [a, a % 100 === 0 ? blob : null]),
    )
    await Promise.all(burst)
    expect(timers).toHaveBeenCalledTimes(1)
    timers.mockClear()
    for (let a = 0; a < 100; a++) await driver.query('SELECT a FROM t WHERE a = ?', [a])
    expect(timers).toHaveBeenCalledTimes(2)
    timers.mockClear()
    for (let a = 0; a < 400; a += 100) await driver.query('SELECT b FROM t WHERE a = ?', [a])
    expect(timers).toHaveBeenCalledTimes(2)
  })

  it('turns after every statement while the stretches between turns run long', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const driver = await open(new ObjectStorage())
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const select = async (): Promise<void> => {
      const answer = driver.query('SELECT 1')
      now += 400
      await answer
    }
    for (let n = 0; n < 50; n++) await select()
    expect(timers).toHaveBeenCalledTimes(1)
    timers.mockClear()
    for (let n = 0; n < 5; n++) await select()
    expect(timers).toHaveBeenCalledTimes(5)
    timers.mockClear()
    for (let n = 0; n < 200; n++) await driver.query('SELECT 1')
    expect(timers.mock.calls.length).toBeLessThan(20)
  })

  it('names the statement SQLite refused', async () => {
    const driver = await open(new ObjectStorage())
    await expect(async () => {
      await driver.query('SELECT * FROM missing')
    }).rejects.toThrow('SELECT * FROM missing: no such table: missing')
    await driver.query('CREATE TABLE t (a INTEGER PRIMARY KEY)')
    await expect(async () => {
      await driver.batch([
        { sql: 'INSERT INTO t (a) VALUES (?)', params: [1] },
        { sql: 'INSERT INTO t (a) VALUES (?)', params: [1] },
      ])
    }).rejects.toThrow('UNIQUE constraint failed: t.a')
    expect(await driver.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }])
  })
})
