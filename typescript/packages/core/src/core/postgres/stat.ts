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
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import { sha256Hex } from '../../utils/hash.ts'
import { compactJsonBytes } from '../render/json.ts'
import { makeStat } from '../hierarchy/stat.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { estimatedRowCount, fetchColumns, tableSizeBytes } from './client.ts'
import { entityGuard, readdir, schemaGuard } from './readdir.ts'
import { detectScope } from './scope.ts'

function schemaExtra(match: ScopeMatch): Record<string, string> {
  return { schema: match.slots.schema ?? '' }
}

function kindExtra(match: ScopeMatch): Record<string, string> {
  return { schema: match.slots.schema ?? '', kind: match.slots.kind ?? '' }
}

function entityExtra(match: ScopeMatch): Record<string, string> {
  return {
    schema: match.slots.schema ?? '',
    kind: match.slots.kind ?? '',
    name: match.slots.entity ?? '',
  }
}

async function rowsStat(
  accessor: PostgresAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<FileStat> {
  await entityGuard(accessor, match, path.virtual)
  const schema = match.slots.schema ?? ''
  const kind = match.slots.kind ?? ''
  const entity = match.slots.entity ?? ''
  const cols = await fetchColumns(accessor, schema, entity)
  const rows = await estimatedRowCount(accessor, schema, entity)
  const size = await tableSizeBytes(accessor, schema, entity)
  const fingerprint = await sha256Hex(compactJsonBytes({ columns: cols, rows }))
  // size stays null: tableSizeBytes is the on-disk storage size, not the
  // rendered JSONL length (FileStat.size must be render-derived or null,
  // see the CLAUDE.md FUSE rules). The storage size remains in extra.
  return new FileStat({
    name: 'rows.jsonl',
    type: FileType.FILE,
    content: ContentType.TEXT,
    size: null,
    fingerprint,
    extra: {
      schema,
      kind,
      name: entity,
      row_count: rows,
      size_bytes: size,
    },
  })
}

export const stat = makeStat<PostgresAccessor>(detectScope, readdir, {
  guards: {
    schema: schemaGuard,
    kind: schemaGuard,
    entity: entityGuard,
    entity_schema: entityGuard,
    entity_semantic: entityGuard,
  },
  extras: {
    schema: schemaExtra,
    kind: kindExtra,
    entity: entityExtra,
    entity_schema: entityExtra,
    entity_semantic: entityExtra,
  },
  overrides: { entity_rows: rowsStat },
})
