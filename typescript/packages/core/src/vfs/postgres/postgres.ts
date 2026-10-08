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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { makeSearchOp } from '../../core/hierarchy/search.ts'
import { read as postgresRead } from '../../core/postgres/read.ts'
import { readdir as postgresReaddir } from '../../core/postgres/readdir.ts'
import { detectScope } from '../../core/postgres/scope.ts'
import { SEARCHERS } from '../../core/postgres/search.ts'
import { stat as postgresStat } from '../../core/postgres/stat.ts'
import type { FileStat, JsonValue, PathSpec } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { BaseVFS } from '../base.ts'
import type { SearchOp, SearchQuery } from '../types.ts'

const searchOp: SearchOp<PostgresAccessor> = makeSearchOp(detectScope, SEARCHERS, postgresStat)

/**
 * Postgres's functions over its accessor, which the node and browser
 * packages build over their own transport.
 */
export class PostgresVFSBase extends BaseVFS<PostgresAccessor> {
  override readonly searchMeta: Readonly<Record<string, JsonValue>> = {
    grep: { mode: 'literal', stream: false },
  }

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return postgresReaddir(this.accessor, path, index)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await postgresRead(this.accessor, path, index)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return postgresStat(this.accessor, path, index)
  }

  override search(
    path: PathSpec,
    query: SearchQuery,
    index?: IndexCacheStore,
  ): Promise<string[] | null> {
    return searchOp(this.accessor, path, query, index)
  }
}
