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

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CHUNK_SIZE, DIR, FILE } from '@struktoai/mirage-core/core/sql/constants'
import { materialize } from '@struktoai/mirage-core/io/types'
import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import { ops } from '@struktoai/mirage-core/test-utils'
import { CapacityState, FileType, MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { checkMutationContract } from '@struktoai/mirage-core/vfs/testing'
import type { SqlDriver } from '@struktoai/mirage-core/vfs/sql/types'
import { SqlRecordClient } from '@struktoai/mirage-core/workspace/record/sql'
import { SqlWorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/sql'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { SqliteDriver } from './driver.ts'
import { PostgresSqlDriver } from './postgres.ts'
import { SqlVFS } from './sql.ts'

const DIRECTORY = new PathSpec({ virtual: '/sql/scratch', directory: '/sql', vfsPath: 'scratch' })
const POSTGRES_URL = process.env.POSTGRES_URL
const enc = new TextEncoder()
const dec = new TextDecoder()
const at = (p: string): PathSpec => PathSpec.fromStrPath(p)

async function bytes(
  vfs: SqlVFS,
  p: string,
  offset = 0,
  size: number | null = null,
): Promise<Uint8Array> {
  return materialize(await vfs.read(at(p), undefined, offset, size))
}

// A writer racing the next op: `other` (statements, or another mount's op)
// lands just before the op's own batch, after its lookups.
function racing(driver: SqlDriver, other: readonly string[] | (() => Promise<void>)): void {
  const batch = driver.batch.bind(driver)
  let pending = true
  driver.batch = async (statements) => {
    if (pending) {
      pending = false
      if (typeof other === 'function') await other()
      else await batch(other.map((s) => ({ sql: s })))
    }
    await batch(statements)
  }
}

// The filesystem behaviour every driver owes, run once per database.
function behaves(open: () => Promise<{ vfs: SqlVFS; driver: SqlDriver }>): void {
  let vfs: SqlVFS
  let driver: SqlDriver

  beforeEach(async () => {
    ;({ vfs, driver } = await open())
  })
  afterEach(async () => {
    await vfs.close()
  })

  it('passes the mutation contract', async () => {
    await ops(vfs).mkdir(at('/scratch'))
    await checkMutationContract(vfs, { directory: DIRECTORY })
  })

  it('keeps a file across chunk boundaries whole and in windows', async () => {
    const data = new Uint8Array(DEFAULT_CHUNK_SIZE * 2 + 5).map((_, i) => i % 251)
    await ops(vfs).write(at('/big'), data)
    expect((await ops(vfs).stat(at('/big'))).size).toBe(data.length)
    expect(await bytes(vfs, '/big')).toEqual(data)
    expect(await bytes(vfs, '/big', DEFAULT_CHUNK_SIZE - 2, 6)).toEqual(
      data.slice(DEFAULT_CHUNK_SIZE - 2, DEFAULT_CHUNK_SIZE + 4),
    )
    expect(await bytes(vfs, '/big', DEFAULT_CHUNK_SIZE * 2)).toEqual(
      data.slice(DEFAULT_CHUNK_SIZE * 2),
    )
    const rows = await driver.query('SELECT COUNT(*) AS n FROM fs_data')
    expect(Number(rows[0]?.n)).toBe(3)
  })

  it('appends across a chunk edge, and truncates down and back up as zeros', async () => {
    const head = new Uint8Array(DEFAULT_CHUNK_SIZE - 1).fill(97)
    await ops(vfs).write(at('/f'), head)
    await ops(vfs).append(at('/f'), enc.encode('xyz'))
    const grown = await bytes(vfs, '/f')
    expect(grown.length).toBe(DEFAULT_CHUNK_SIZE + 2)
    expect(dec.decode(grown.slice(-3))).toBe('xyz')
    await ops(vfs).truncate(at('/f'), 2)
    await ops(vfs).truncate(at('/f'), 5)
    expect(await bytes(vfs, '/f')).toEqual(new Uint8Array([97, 97, 0, 0, 0]))
    await vfs.truncate(at('/missing'), 3, true)
    expect(await vfs.exists(at('/missing'))).toBe(false)
  })

  it('lands a stream as it arrives', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* parts(): AsyncIterable<Uint8Array> {
      yield enc.encode('ab')
      yield enc.encode('cd')
    }
    await vfs.write(at('/s'), parts())
    expect(dec.decode(await bytes(vfs, '/s'))).toBe('abcd')
    await vfs.append(at('/s'), parts())
    expect(dec.decode(await bytes(vfs, '/s'))).toBe('abcdabcd')
  })

  it('moves a tree with one entry and removes it whole', async () => {
    await ops(vfs).mkdir(at('/a/b'), true)
    await ops(vfs).write(at('/a/b/f'), enc.encode('hi'))
    await ops(vfs).rename(at('/a'), at('/z'))
    expect(dec.decode(await bytes(vfs, '/z/b/f'))).toBe('hi')
    expect(await vfs.exists(at('/a'))).toBe(false)
    await expect(ops(vfs).rename(at('/z'), at('/z/b/in'))).rejects.toThrow()
    await vfs.rmR(at('/z'))
    expect(await ops(vfs).readdir(at('/'))).toEqual([])
    const left = await driver.query('SELECT COUNT(*) AS n FROM fs_inode')
    expect(Number(left[0]?.n)).toBe(1)
  })

  it('copies inside the database and keeps the source', async () => {
    await ops(vfs).write(at('/src'), enc.encode('copied'))
    await vfs.copy(at('/src'), at('/dst'))
    expect(dec.decode(await bytes(vfs, '/dst'))).toBe('copied')
    expect(dec.decode(await bytes(vfs, '/src'))).toBe('copied')
  })

  it('walks a path deeper than one query joins', async () => {
    const deep = `/${Array.from({ length: 40 }, (_, i) => `d${String(i)}`).join('/')}`
    await vfs.mkdir(at(deep), true)
    await ops(vfs).write(at(`${deep}/f`), enc.encode('deep'))
    expect(dec.decode(await bytes(vfs, `${deep}/f`))).toBe('deep')
    expect((await ops(vfs).stat(at(deep))).type).toBe(FileType.DIRECTORY)
    expect(await vfs.exists(at(`${deep}/nope/f`))).toBe(false)
  })

  it('refuses a move onto a directory written into since its check, stranding nothing', async () => {
    await vfs.mkdir(at('/src'))
    await vfs.mkdir(at('/dst'))
    racing(driver, [
      `INSERT INTO fs_inode (ino, mode, size, mtime) VALUES (1000, ${String(FILE)}, 0, 0)`,
      "INSERT INTO fs_dentry (name, parent_ino, ino) SELECT 'new', ino, 1000 FROM fs_dentry WHERE parent_ino = 1 AND name = 'dst'",
    ])
    await expect(vfs.rename(at('/src'), at('/dst'))).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(await vfs.exists(at('/dst/new'))).toBe(true)
    expect(await vfs.exists(at('/src'))).toBe(true)
  })

  it('fails a write whose directory went since its lookup, stranding nothing', async () => {
    await vfs.mkdir(at('/d'))
    racing(driver, [
      "DELETE FROM fs_inode WHERE ino IN (SELECT ino FROM fs_dentry WHERE parent_ino = 1 AND name = 'd')",
      "DELETE FROM fs_dentry WHERE parent_ino = 1 AND name = 'd'",
    ])
    await expect(ops(vfs).write(at('/d/f'), enc.encode('x'))).rejects.toThrow()
    const inodes = await driver.query('SELECT ino FROM fs_inode')
    expect(inodes.map((r) => Number(r.ino))).toEqual([1])
  })

  it('lands an append another mount raced at the end that one left', async () => {
    await ops(vfs).write(at('/f'), enc.encode('a'))
    const other = new SqlVFS({ driver })
    racing(driver, () => ops(other).append(at('/f'), enc.encode('b')))
    await ops(vfs).append(at('/f'), enc.encode('c'))
    expect(dec.decode(await bytes(vfs, '/f'))).toBe('abc')
  })

  it('keeps a file another writer moved while an unlink of its old name ran', async () => {
    await ops(vfs).write(at('/a'), enc.encode('kept'))
    racing(driver, ["UPDATE fs_dentry SET name = 'b' WHERE parent_ino = 1 AND name = 'a'"])
    await vfs.unlink(at('/a'))
    expect(dec.decode(await bytes(vfs, '/b'))).toBe('kept')
  })

  it('retries an append on its own file, not on what now stands at its path', async () => {
    await ops(vfs).write(at('/f'), enc.encode('a'))
    racing(driver, [
      "UPDATE fs_dentry SET name = 'g' WHERE parent_ino = 1 AND name = 'f'",
      "UPDATE fs_inode SET mtime = mtime + 1 WHERE ino = (SELECT ino FROM fs_dentry WHERE parent_ino = 1 AND name = 'g')",
      `INSERT INTO fs_inode (ino, mode, size, mtime) VALUES (1000, ${String(DIR)}, 0, 0)`,
      "INSERT INTO fs_dentry (name, parent_ino, ino) VALUES ('f', 1, 1000)",
    ])
    await ops(vfs).append(at('/f'), enc.encode('c'))
    expect(dec.decode(await bytes(vfs, '/g'))).toBe('ac')
    expect((await ops(vfs).stat(at('/f'))).type).toBe(FileType.DIRECTORY)
  })

  it('restores into fresh inode numbers, past every one an op could hold', async () => {
    const deep = `/${Array.from({ length: 40 }, (_, i) => `d${String(i)}`).join('/')}`
    await vfs.mkdir(at(deep), true)
    await ops(vfs).write(at(`${deep}/f`), enc.encode('x'))
    const inos = async (): Promise<number[]> =>
      (await driver.query('SELECT ino FROM fs_inode WHERE ino > 1')).map((r) => Number(r.ino))
    const before = Math.max(...(await inos()))
    await vfs.loadState(await vfs.getState())
    expect(Math.min(...(await inos()))).toBeGreaterThan(before)
    expect(dec.decode(await bytes(vfs, `${deep}/f`))).toBe('x')
    await ops(vfs).write(at('/later'), enc.encode('y'))
    expect(dec.decode(await bytes(vfs, '/later'))).toBe('y')
  })

  it('keeps no attributes, so the namespace keeps them', () => {
    expect(vfs.supports('setattr')).toBe(false)
  })
}

describe('SqlVFS over SQLite', () => {
  behaves(() => {
    const driver = new SqliteDriver()
    return Promise.resolve({ vfs: new SqlVFS({ driver }), driver })
  })
})

describe.skipIf(POSTGRES_URL === undefined)('SqlVFS over Postgres', () => {
  behaves(async () => {
    const driver = new PostgresSqlDriver(POSTGRES_URL ?? '')
    for (const table of ['fs_data', 'fs_dentry', 'fs_inode', 'fs_config']) {
      await driver.query(`DROP TABLE IF EXISTS ${table}`)
    }
    const vfs = new SqlVFS({ driver })
    // The borrowed driver closes with the suite's mount.
    const close = vfs.close.bind(vfs)
    vfs.close = async () => {
      await close()
      await driver.close()
    }
    return { vfs, driver }
  })
})

describe('SqlVFS tables', () => {
  it('hold the tree and the bytes alone', async () => {
    const driver = new SqliteDriver()
    const vfs = new SqlVFS({ driver })
    try {
      await ops(vfs).mkdir(at('/d'))
      await ops(vfs).write(at('/d/f'), enc.encode('hi'))
      const tables = await driver.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fs_%' ORDER BY name",
      )
      expect(tables.map((t) => t.name)).toEqual(['fs_config', 'fs_data', 'fs_dentry', 'fs_inode'])
      expect(await driver.query('SELECT key, value FROM fs_config')).toEqual([
        { key: 'chunk_size', value: String(DEFAULT_CHUNK_SIZE) },
      ])
      const tree = await driver.query(
        `SELECT d.name, i.mode, i.size FROM fs_dentry d JOIN fs_inode i ON i.ino = d.ino
         ORDER BY d.name`,
      )
      expect(tree).toEqual([
        { name: 'd', mode: DIR, size: 0 },
        { name: 'f', mode: FILE, size: 2 },
      ])
    } finally {
      await vfs.close()
      await driver.close()
    }
  })

  it('leave chmod to the namespace, which the workspace store keeps', async () => {
    const driver = new SqliteDriver()
    const ws = new Workspace({ '/w/': new SqlVFS({ driver }) }, { mode: MountMode.WRITE })
    try {
      const r = await ws.shell('touch /w/f && chmod 600 /w/f && stat -c %a /w/f')
      expect(r.stdoutText).toBe('600\n')
      expect(await driver.query('SELECT mode FROM fs_inode WHERE ino > 1')).toEqual([
        { mode: FILE },
      ])
    } finally {
      await ws.close()
      await driver.close()
    }
  })
})

describe('SqlRecordClient', () => {
  it('writes a CAS record only at the generation it expects', async () => {
    const driver = new SqliteDriver()
    const records = new SqlRecordClient(driver, 'w/sessions/')
    expect(await records.casPut('s', { generation: 1, cwd: '/' }, 0)).toBe(true)
    expect(await records.casPut('s', { generation: 1, cwd: '/x' }, 0)).toBe(false)
    expect(await records.casPut('s', { generation: 2, cwd: '/y' }, 1)).toBe(true)
    expect(await records.casPut('s', { generation: 3, cwd: '/z' }, 1)).toBe(false)
    expect((await records.get('s'))[0]).toEqual({ generation: 2, cwd: '/y' })
    await records.put('legacy', { cwd: '/' })
    await records.put('legacy', { cwd: '/' })
    expect(await records.casPut('legacy', { generation: 1, cwd: '/a' }, 0)).toBe(true)
    expect(await new SqlRecordClient(driver, 'other/').listNames()).toEqual([])
    expect(await records.listNames()).toEqual(['legacy', 's'])
    await driver.close()
  })
})

describe('SqlWorkspaceStateStore', () => {
  it("keeps a workspace's cwd and exported env for the next workspace on the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-sql-'))
    const path = join(dir, 'state.db')
    const open = (): Workspace =>
      new Workspace(
        { '/work/': new SqlVFS({ path }) },
        {
          mode: MountMode.WRITE,
          workspaceId: 'w1',
          store: new SqlWorkspaceStateStore(new SqliteDriver(path), { ownsDriver: true }),
          ownsStore: true,
        },
      )
    try {
      const first = open()
      try {
        expect((await first.shell('mkdir -p /work/p && cd /work/p && export A=1')).exitCode).toBe(0)
      } finally {
        await first.close()
      }
      const second = open()
      try {
        expect((await second.shell('pwd; echo "A=$A"')).stdoutText).toBe('/work/p\nA=1\n')
      } finally {
        await second.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('SqlVFS', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirage-sql-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves the shell, and a reopened file keeps what was written', async () => {
    const path = join(dir, 'fs.db')
    const first = new Workspace({ '/work/': new SqlVFS({ path }) }, { mode: MountMode.WRITE })
    try {
      const r = await first.shell(
        "mkdir -p /work/out && printf 'b\\na\\n' > /work/out/x.txt && mv /work/out/x.txt /work/out/y.txt && sort /work/out/y.txt",
      )
      expect(r.exitCode).toBe(0)
      expect(r.stdoutText).toBe('a\nb\n')
    } finally {
      await first.close()
    }
    const second = new Workspace({ '/work/': new SqlVFS({ path }) }, { mode: MountMode.WRITE })
    try {
      const r = await second.shell('ls /work/out && cat /work/out/y.txt')
      expect(r.stdoutText).toBe('y.txt\nb\na\n')
    } finally {
      await second.close()
    }
  })

  it('carries its files into a fresh mount through a snapshot', async () => {
    const source = new SqlVFS()
    const ws = new Workspace({ '/w/': source }, { mode: MountMode.WRITE })
    let state: Awaited<ReturnType<SqlVFS['getState']>>
    try {
      expect((await ws.shell('mkdir -p /w/d && printf hi > /w/d/f')).exitCode).toBe(0)
      state = await source.getState()
    } finally {
      await ws.close()
    }
    expect(state.config).toEqual({})
    expect(Object.keys(state.files)).toEqual(['/d/f'])
    expect(state.dirs).toEqual(['/', '/d'])
    const copy = new SqlVFS()
    try {
      await copy.loadState(state)
      expect(dec.decode(await bytes(copy, '/d/f'))).toBe('hi')
      expect((await ops(copy).stat(at('/d'))).type).toBe(FileType.DIRECTORY)
    } finally {
      await copy.close()
    }
  })

  it('records its ops under its own name', async () => {
    const vfs = new SqlVFS()
    const path = at('/f')
    try {
      const [, records] = await runWithRecording(async () => {
        await ops(vfs).write(path, enc.encode('hi'))
        await ops(vfs).read(path)
      })
      expect(records.map((r) => [r.op, r.source])).toEqual([
        ['write', 'sql'],
        ['read', 'sql'],
      ])
    } finally {
      await vfs.close()
    }
  })

  it('reads an uncapped database as growing', async () => {
    const vfs = new SqlVFS()
    try {
      expect((await vfs.capacity()).state).toBe(CapacityState.ELASTIC)
      expect(vfs.storageLocation()).toMatch(/^sql::memory:#\d+$/)
    } finally {
      await vfs.close()
    }
  })

  it('opens again after a first open failed', async () => {
    const driver = new SqliteDriver(join(dir, 'later', 'fs.db'))
    await expect(driver.query('SELECT 1 AS n')).rejects.toThrow()
    mkdirSync(join(dir, 'later'))
    expect(await driver.query('SELECT 1 AS n')).toEqual([{ n: 1 }])
    await driver.close()
  })

  it('tells two in-memory databases apart, and two names of one file alike', () => {
    expect(new SqlVFS().storageLocation()).not.toBe(new SqlVFS().storageLocation())
    const path = join(dir, 'fs.db')
    expect(new SqlVFS({ path }).storageLocation()).toBe(
      new SqlVFS({ path: join(dir, '.', 'fs.db') }).storageLocation(),
    )
  })

  it('takes a path or a driver, not both', () => {
    expect(() => new SqlVFS({ path: ':memory:', driver: new SqliteDriver() })).toThrow(
      'SqlVFS takes a path or a driver, not both',
    )
  })
})
