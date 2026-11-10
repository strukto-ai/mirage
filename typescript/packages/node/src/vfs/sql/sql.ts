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

import { VFSConfigError } from '@struktoai/mirage-core/vfs/errors'
import { SqlVFS as CoreSqlVFS } from '@struktoai/mirage-core/vfs/sql/sql'
import type { SqlDriver } from '@struktoai/mirage-core/vfs/sql/types'
import { SqliteDriver } from './driver.ts'

export interface SqlVFSOptions {
  /** The SQLite file the mount lives in; `:memory:` keeps it in this process. */
  path?: string
  /** A database to borrow instead of a file, a `PostgresSqlDriver` say; the
   * caller closes it. */
  driver?: SqlDriver
  /** The most bytes the database's files may hold: a size like `100MB` or a
   * count of bytes. */
  capacity?: number | string | null
  /** The folder of the database the mount serves, made when missing; `/` for
   * all of it. */
  root?: string
}

/**
 * The node sql mount: the shared VFS over a SQLite file, or over a driver it
 * is handed.
 *
 * Everything filesystem-shaped lives in core's `SqlVFS`; this class only
 * opens the file, which it owns and closes with the mount. Mirrors Python's
 * `SqlVFS`.
 *
 * @throws VFSConfigError when both `path` and `driver` are given.
 */
export class SqlVFS extends CoreSqlVFS {
  constructor(options: SqlVFSOptions = {}) {
    if (options.path !== undefined && options.driver !== undefined) {
      throw new VFSConfigError('SqlVFS takes a path or a driver, not both')
    }
    super(options.driver ?? new SqliteDriver(options.path ?? ':memory:'), {
      capacity: options.capacity ?? null,
      root: options.root ?? '/',
      ownsDriver: options.driver === undefined,
    })
  }
}
