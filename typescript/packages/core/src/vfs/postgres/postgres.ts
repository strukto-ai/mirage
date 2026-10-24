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

import type { PostgresAccessor } from '../../accessor/postgres.ts'
import {
  firstLines as postgresFirstLines,
  follow as postgresFollow,
  lastLines as postgresLastLines,
  lineCount as postgresLineCount,
  readStream as postgresReadStream,
} from '../../core/postgres/read.ts'
import { readdir as postgresReaddir } from '../../core/postgres/readdir.ts'
import { linesContaining as postgresLinesContaining } from '../../core/postgres/search.ts'
import { stat as postgresStat } from '../../core/postgres/stat.ts'
import type { ByteSource } from '../../io/types.ts'
import type { DirListing, FileStat, PathSpec } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'

export const VFS_MD = `{prefix}
  database.json                  cross-schema graph + sizes
  <schema>/                      Postgres schema (namespace)
    tables/<table>/
      schema.json                column types, PK/FK, indexes
      semantic.json              descriptions, roles, sample values
      rows.jsonl                 data (size-guarded)
    views/<view>/
      schema.json
      semantic.json
      rows.jsonl
  Read semantic.json to learn what a table means: it splits columns into
  dimensions (group by), time_dimensions and facts (aggregate), and
  carries COMMENTs, enum domains and example values.
  Read database.json first to plan joins. Reading rows.jsonl is refused
  for tables above the configured row/byte threshold; use head, tail or
  wc, which ask SQL for only what they need, or grep, which fetches only
  the matching rows when SQL can find every match.`

/**
 * Postgres's functions over its accessor, which the node and browser
 * packages build over their own transport.
 */
export class PostgresVFSBase extends BaseVFS<PostgresAccessor> {
  override readonly handed = {
    read: ['parent'],
    stat: ['entry'],
  } as const

  override readdir(path: PathSpec): Promise<FileStat[] | DirListing> {
    return postgresReaddir(this.accessor, path)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async read(path: PathSpec, handed?: Handed): Promise<ByteSource> {
    return postgresReadStream(this.accessor, path, handed?.entry ?? null, handed?.parent ?? null)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return postgresStat(this.accessor, path, handed?.entry)
  }

  override linesContaining(
    path: PathSpec,
    text: string,
    opts: { ignoreCase: boolean },
  ): Promise<ByteSource | null> {
    return postgresLinesContaining(this.accessor, path, text, opts.ignoreCase)
  }

  override firstLines(path: PathSpec, n: number): Promise<Uint8Array | null> {
    return postgresFirstLines(this.accessor, path, n)
  }

  override lastLines(path: PathSpec, n: number): Promise<Uint8Array | null> {
    return postgresLastLines(this.accessor, path, n)
  }

  override lineCount(path: PathSpec): Promise<number | null> {
    return postgresLineCount(this.accessor, path)
  }

  override follow(
    path: PathSpec,
    n: number,
    interval: number,
  ): Promise<AsyncIterable<Uint8Array> | null> {
    return postgresFollow(this.accessor, path, n, interval)
  }
}
