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
import { DurableObjectPagedSqlDriver } from './driver.ts'

const wasm = sqliteWasm()
const decoder = new TextDecoder()

function open(storage: ObjectStorage): Promise<DurableObjectPagedSqlDriver> {
  return DurableObjectPagedSqlDriver.open(storage, { wasm })
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
    const second = await open(storage)
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
    storage.writesLeft = null
    expect(await lines(await open(storage), ['ls /s', 'cat /s/a'])).toBe('a\nkept')
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
