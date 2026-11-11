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
import { norm } from '../utils/path.ts'
import { stripSlash } from '../utils/slash.ts'
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from '../vfs/sql/types.ts'
import { Accessor } from './base.ts'

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
    await this.folder(true)
    return Number(row?.value) || DEFAULT_CHUNK_SIZE
  }

  /**
   * The inode of the mount's folder. Only the first open makes it: a folder
   * gone since is ENOENT, and a file standing at it ENOTDIR.
   */
  async rootIno(): Promise<number> {
    await this.chunkSize()
    return this.folder(false)
  }

  // Each name of the folder in turn, made where the database has none when
  // `make`, as the root is: a directory inode and the entry naming it, its
  // parent named through its inode. A writer that makes one first holds its
  // entry, so this one's insert fails and it reads the entry instead.
  private async folder(make: boolean): Promise<number> {
    let ino = ROOT_INO
    for (const name of this.rootNames) {
      const entry = (): Promise<SqlRow[]> => this.driver.query(SQL.entry, [ino, name])
      let row = (await entry())[0]
      if (row === undefined && make) {
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

  /** Run `statements` in one transaction, once the tables are there. */
  async batch(statements: readonly SqlStatement[]): Promise<void> {
    if (statements.length === 0) return
    await this.chunkSize()
    await this.driver.batch(statements)
  }
}
