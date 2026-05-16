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

import { PathSpec } from '../../types.ts'
import { EntityKind, KIND_DIR_NAMES, ScopeLevel } from './types.ts'

export interface MongoDBScope {
  level: ScopeLevel
  database: string | null
  kind: EntityKind | null
  name: string | null
  resourcePath: string
}

function scope(
  level: ScopeLevel,
  resourcePath: string,
  database: string | null = null,
  kind: EntityKind | null = null,
  name: string | null = null,
): MongoDBScope {
  return { level, database, kind, name, resourcePath }
}

export function detectScope(path: PathSpec | string): MongoDBScope {
  const raw = path instanceof PathSpec ? path.stripPrefix : path
  const key = raw.replace(/^\/+|\/+$/g, '')

  if (key === '') {
    return scope(ScopeLevel.ROOT, '/')
  }

  const parts = key.split('/')

  if (parts.length === 1) {
    return scope(ScopeLevel.DATABASE, raw, parts[0])
  }

  if (parts.length === 2) {
    const [db, leaf] = parts
    if (leaf === 'database.json') {
      return scope(ScopeLevel.DATABASE_JSON, raw, db)
    }
    if (leaf in KIND_DIR_NAMES) {
      return scope(ScopeLevel.KIND_DIR, raw, db, KIND_DIR_NAMES[leaf])
    }
    return scope(ScopeLevel.UNKNOWN, raw)
  }

  if (parts.length === 3) {
    const [db, kindSeg, name] = parts
    if (kindSeg in KIND_DIR_NAMES) {
      return scope(ScopeLevel.ENTITY, raw, db, KIND_DIR_NAMES[kindSeg], name)
    }
    return scope(ScopeLevel.UNKNOWN, raw)
  }

  if (parts.length === 4) {
    const [db, kindSeg, name, leaf] = parts
    if (kindSeg in KIND_DIR_NAMES) {
      const kind = KIND_DIR_NAMES[kindSeg]
      if (leaf === 'schema.json') {
        return scope(ScopeLevel.SCHEMA_JSON, raw, db, kind, name)
      }
      if (leaf === 'documents.jsonl') {
        return scope(ScopeLevel.DOCUMENTS, raw, db, kind, name)
      }
    }
    return scope(ScopeLevel.UNKNOWN, raw)
  }

  return scope(ScopeLevel.UNKNOWN, raw)
}
