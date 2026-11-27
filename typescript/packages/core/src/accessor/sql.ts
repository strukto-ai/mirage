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

import { DEFAULT_CHUNK_SIZE, DIR, LAST_INO, ROOT_INO, SCHEMA, SQL } from '../core/sql/constants.ts'
import { enoent, enotdir } from '../errors/fs.ts'
import { PathSpec } from '../types.ts'
import { systemDate } from '../utils/clock.ts'
import { stampAfter } from '../utils/dates.ts'
import { norm } from '../utils/path.ts'
import { stripSlash } from '../utils/slash.ts'
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from '../vfs/sql/types.ts'
import { Accessor } from './base.ts'

// How many times each driver's tree lost or moved an entry, through any
// mount on it.
const STRUCTURE = new WeakMap<SqlDriver, number>()
// The last time each driver's writes landed at, in nanoseconds, through
// any mount on it.
const STAMPS = new WeakMap<SqlDriver, bigint>()
// A statement that removes or moves an entry or an inode.
const RESHAPES = /DELETE FROM fs_(?:inode|dentry)|UPDATE fs_dentry/

/**
 * A sql mount's database: its driver, the folder of it the mount serves,
 * and the tables the ops read, made on the first statement with the
 * folder. Mirrors Python's `SqlAccessor`.
 */
export class SqlAccessor extends Accessor {
  readonly driver: SqlDriver
  /** The folder of the database the mount serves, `/` for all of it. */
  readonly root: string
  /** The names the ops walk from the database's root to `root`. */
  readonly rootNames: readonly string[]
  private opened: Promise<number> | null = null

  constructor(driver: SqlDriver, root = '/') {
    super()
    this.driver = driver
    this.root = norm(root)
    const bare = stripSlash(this.root)
    this.rootNames = bare === '' ? [] : bare.split('/')
  }

  /**
   * The bytes one row of a file holds, as the database records it; the
   * tables, the root and the mount's folder are made first when the
   * database has none.
   */
  chunkSize(): Promise<number> {
    this.opened ??= this.open().catch((err: unknown) => {
      this.opened = null
      throw err
    })
    return this.opened
  }

  private async open(): Promise<number> {
    const now = Math.floor(systemDate().getTime() / 1000)
    await this.driver.batch([
      ...SCHEMA[this.driver.dialect].map((sql) => ({ sql })),
      { sql: SQL.seedRoot, params: [now] },
    ])
    const row = (await this.driver.query(SQL.chunkSize))[0]
    await this.folder()
    return Number(row?.value) || DEFAULT_CHUNK_SIZE
  }

  /**
   * The inode of the mount's folder, made again with its parents when gone,
   * so a snapshot of the whole database taken first restores beside it in
   * either order. A file standing at it is ENOTDIR.
   */
  async rootIno(): Promise<number> {
    await this.chunkSize()
    return this.folder()
  }

  // Each name of the folder in turn, made where the database has none, as
  // the root is: a directory inode and the entry naming it, its parent named
  // through its inode. A writer that makes one first holds its entry, so
  // this one's insert fails and it reads the entry instead.
  private async folder(): Promise<number> {
    let ino = ROOT_INO
    for (const name of this.rootNames) {
      const entry = (): Promise<SqlRow[]> => this.driver.query(SQL.entry, [ino, name])
      let row = (await entry())[0]
      if (row === undefined) {
        const now = Math.floor(systemDate().getTime() / 1000)
        try {
          await this.driver.batch([
            { sql: SQL.newInode, params: [DIR, 0, now, 0] },
            {
              sql: `INSERT INTO fs_dentry (name, parent_ino, ino)
                VALUES (?, (SELECT ino FROM fs_inode WHERE ino = ?), ${LAST_INO[this.driver.dialect]})`,
              params: [name, ino],
            },
          ])
        } catch (err) {
          if ((await entry())[0] === undefined) throw err
          console.debug(`sql: ${this.root} was made by another writer first`, err)
        }
        row = (await entry())[0]
      }
      if (row === undefined) throw enoent(PathSpec.fromStrPath(this.root))
      if (Number(row.mode) !== DIR) throw enotdir(PathSpec.fromStrPath(this.root))
      ino = Number(row.ino)
    }
    return ino
  }

  /** The rows one statement answers, once the tables are there. */
  async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    await this.chunkSize()
    return this.driver.query(sql, params)
  }

  /**
   * Run `statements` in one transaction, once the tables are there. One
   * that removes or moves an entry moves `structure` on, before it runs and
   * once it has, so nothing read while it ran is kept.
   */
  async batch(statements: readonly SqlStatement[]): Promise<void> {
    if (statements.length === 0) return
    await this.chunkSize()
    const reshapes = statements.some((statement) => RESHAPES.test(statement.sql))
    if (!reshapes) {
      await this.driver.batch(statements)
      return
    }
    this.reshaped()
    try {
      await this.driver.batch(statements)
    } finally {
      this.reshaped()
    }
  }

  /**
   * A count that moves whenever the driver's tree loses or moves an entry:
   * what a path resolved to is as it was only while this reads the same.
   */
  structure(): number {
    return STRUCTURE.get(this.driver) ?? 0
  }

  /** Mark the tree as having lost or moved an entry. */
  reshaped(): void {
    STRUCTURE.set(this.driver, this.structure() + 1)
  }

  /**
   * The time a write lands at, in nanoseconds: now, past every time a mount
   * on the driver gave a write before.
   */
  stamped(): bigint {
    const ns = stampAfter(STAMPS.get(this.driver) ?? 0n)
    STAMPS.set(this.driver, ns)
    return ns
  }
}
