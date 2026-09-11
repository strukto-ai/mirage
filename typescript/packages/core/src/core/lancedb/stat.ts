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

import type { LanceDBAccessor } from '../../accessor/lancedb.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { contentTypeForExtension } from '../../utils/filetype.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { perAccessor } from '../hierarchy/bind.ts'
import type { Guard } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat, type StatHook } from '../hierarchy/stat.ts'
import { read } from './read.ts'
import { readdirFor } from './readdir.ts'
import { detectFor, tableOf } from './scope.ts'

function nameOf(spec: PathSpec): string {
  const stripped = rstripSlash(spec.virtual)
  const last = stripped.split('/').pop()
  return last === undefined || last === '' ? '/' : last
}

async function tableGuard(
  accessor: LanceDBAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<void> {
  const tables = await accessor.driver.listTables()
  if (!tables.includes(tableOf(accessor.config, match))) throw enoent(virtual)
}

async function statRow(
  accessor: LanceDBAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const config = accessor.config
  const tables = await accessor.driver.listTables()
  if (!tables.includes(tableOf(config, match))) throw enoent(path.virtual)
  const content =
    match.kind === 'row_blob' ? contentTypeForExtension(config.blobExt) : ContentType.TEXT
  // The row-dir readdir seeds exact card sizes; blob entries and a cold
  // index fall back to rendering the row, so the size is exact either way.
  if (index !== undefined) {
    const lookup = await index.get(rstripSlash(path.virtual))
    if (lookup.entry !== undefined && lookup.entry !== null && lookup.entry.size !== null) {
      return new FileStat({
        name: nameOf(path),
        size: lookup.entry.size,
        type: FileType.FILE,
        content,
      })
    }
  }
  const data = await read(accessor, path, index)
  return new FileStat({ name: nameOf(path), size: data.length, type: FileType.FILE, content })
}

const GUARDS: Record<string, Guard<LanceDBAccessor>> = { group: tableGuard }

const OVERRIDES: Record<string, StatHook<LanceDBAccessor>> = {
  row_card: statRow,
  row_blob: statRow,
}

function buildStat(accessor: LanceDBAccessor) {
  return makeStat(detectFor(accessor), readdirFor(accessor), {
    guards: GUARDS,
    overrides: OVERRIDES,
  })
}

const statFor = perAccessor(buildStat)

export async function stat(
  accessor: LanceDBAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  return statFor(accessor)(accessor, spec, index)
}
