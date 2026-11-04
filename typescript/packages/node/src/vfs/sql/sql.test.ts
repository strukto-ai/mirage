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
import { DEFAULT_CHUNK_SIZE } from '@struktoai/mirage-core/core/sql/constants'
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

  it('stores a numeric owner and hands a name back to the overlay', async () => {
    await ops(vfs).write(at('/o'), enc.encode('x'))
    expect(await vfs.setattr(at('/o'), { mode: 0o600, uid: 1000, gid: 'staff' })).toEqual({
      gid: 'staff',
    })
    const st = await ops(vfs).stat(at('/o'))
    expect([st.mode, st.uid, st.gid]).toEqual([0o600, 1000, null])
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
    for (const table of ['fs_data', 'fs_symlink', 'fs_dentry', 'fs_inode', 'fs_config']) {
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

describe('SqlVFS and AgentFS', () => {
  it('mounts a database AgentFS made, at its own chunk size', async () => {
    const driver = new SqliteDriver()
    await driver.batch([
      { sql: 'CREATE TABLE fs_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)' },
      { sql: "INSERT INTO fs_config VALUES ('chunk_size', '4')" },
      {
        sql: `CREATE TABLE fs_inode (ino INTEGER PRIMARY KEY AUTOINCREMENT, mode INTEGER NOT NULL,
          nlink INTEGER NOT NULL DEFAULT 0, uid INTEGER NOT NULL DEFAULT 0,
          gid INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
          atime INTEGER NOT NULL, mtime INTEGER NOT NULL, ctime INTEGER NOT NULL,
          rdev INTEGER NOT NULL DEFAULT 0, atime_nsec INTEGER NOT NULL DEFAULT 0,
          mtime_nsec INTEGER NOT NULL DEFAULT 0, ctime_nsec INTEGER NOT NULL DEFAULT 0)`,
      },
      {
        sql: `CREATE TABLE fs_dentry (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
          parent_ino INTEGER NOT NULL, ino INTEGER NOT NULL, UNIQUE(parent_ino, name))`,
      },
      {
        sql: `CREATE TABLE fs_data (ino INTEGER NOT NULL, chunk_index INTEGER NOT NULL,
          data BLOB NOT NULL, PRIMARY KEY (ino, chunk_index))`,
      },
      { sql: 'CREATE TABLE fs_symlink (ino INTEGER PRIMARY KEY, target TEXT NOT NULL)' },
      {
        sql: 'INSERT INTO fs_inode (ino, mode, nlink, atime, mtime, ctime) VALUES (1, 16877, 1, 0, 0, 0)',
      },
      {
        sql: 'INSERT INTO fs_inode (ino, mode, nlink, size, atime, mtime, ctime) VALUES (2, 33188, 2, 10, 0, 0, 0)',
      },
      { sql: "INSERT INTO fs_dentry (name, parent_ino, ino) VALUES ('notes.txt', 1, 2)" },
      { sql: "INSERT INTO fs_dentry (name, parent_ino, ino) VALUES ('link.txt', 1, 2)" },
      {
        sql: "INSERT INTO fs_data VALUES (2, 0, x'68656c6c'), (2, 1, x'6f20776f'), (2, 2, x'726c')",
      },
    ])
    const vfs = new SqlVFS({ driver })
    try {
      expect(dec.decode(await bytes(vfs, '/notes.txt'))).toBe('hello worl')
      await ops(vfs).append(at('/notes.txt'), enc.encode('d!'))
      expect(dec.decode(await bytes(vfs, '/link.txt'))).toBe('hello world!')
      const rows = await driver.query(
        'SELECT chunk_index, length(data) AS n FROM fs_data WHERE ino = 2 ORDER BY chunk_index',
      )
      expect(rows.map((r) => Number(r.n))).toEqual([4, 4, 4])
      await ops(vfs).unlink(at('/notes.txt'))
      expect(dec.decode(await bytes(vfs, '/link.txt'))).toBe('hello world!')
      const ino = await driver.query('SELECT nlink FROM fs_inode WHERE ino = 2')
      expect(Number(ino[0]?.nlink)).toBe(1)
    } finally {
      await vfs.close()
      await driver.close()
    }
  })

  it('writes the tables AgentFS reads', async () => {
    const driver = new SqliteDriver()
    const vfs = new SqlVFS({ driver })
    try {
      await ops(vfs).mkdir(at('/d'))
      await ops(vfs).write(at('/d/f'), enc.encode('hi'))
      const config = await driver.query('SELECT key, value FROM fs_config ORDER BY key')
      expect(config).toEqual([
        { key: 'chunk_size', value: String(DEFAULT_CHUNK_SIZE) },
        { key: 'schema_version', value: '0.4' },
      ])
      const tree = await driver.query(
        `SELECT d.name, i.mode, i.nlink, i.size FROM fs_dentry d JOIN fs_inode i ON i.ino = d.ino
         ORDER BY d.name`,
      )
      expect(tree).toEqual([
        { name: 'd', mode: 0o40755, nlink: 1, size: 0 },
        { name: 'f', mode: 0o100644, nlink: 1, size: 2 },
      ])
      expect((await ops(vfs).stat(at('/d/f'))).type).toBe(FileType.FILE)
    } finally {
      await vfs.close()
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
      expect(
        (await ws.shell('mkdir -p /w/d && printf hi > /w/d/f && chmod 600 /w/d/f')).exitCode,
      ).toBe(0)
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
      expect((await ops(copy).stat(at('/d/f'))).mode).toBe(0o600)
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
      expect(vfs.storageLocation()).toBe('sql::memory:')
    } finally {
      await vfs.close()
    }
  })

  it('takes a path or a driver, not both', () => {
    expect(() => new SqlVFS({ path: ':memory:', driver: new SqliteDriver() })).toThrow(
      'SqlVFS takes a path or a driver, not both',
    )
  })
})
