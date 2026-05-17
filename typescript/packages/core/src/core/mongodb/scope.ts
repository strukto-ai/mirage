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
import type { EntityKind } from './types.ts'
import { KIND_DIR_NAMES, ScopeLevel } from './types.ts'

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
    const db = parts[0] ?? ''
    const leaf = parts[1] ?? ''
    if (leaf === 'database.json') {
      return scope(ScopeLevel.DATABASE_JSON, raw, db)
    }
    const dirKind = KIND_DIR_NAMES[leaf]
    if (dirKind !== undefined) {
      return scope(ScopeLevel.KIND_DIR, raw, db, dirKind)
    }
    return scope(ScopeLevel.UNKNOWN, raw)
  }

  if (parts.length === 3) {
    const db = parts[0] ?? ''
    const kindSeg = parts[1] ?? ''
    const name = parts[2] ?? ''
    const dirKind = KIND_DIR_NAMES[kindSeg]
    if (dirKind !== undefined) {
      return scope(ScopeLevel.ENTITY, raw, db, dirKind, name)
    }
    return scope(ScopeLevel.UNKNOWN, raw)
  }

  if (parts.length === 4) {
    const db = parts[0] ?? ''
    const kindSeg = parts[1] ?? ''
    const name = parts[2] ?? ''
    const leaf = parts[3] ?? ''
    const dirKind = KIND_DIR_NAMES[kindSeg]
    if (dirKind !== undefined) {
      if (leaf === 'schema.json') {
        return scope(ScopeLevel.SCHEMA_JSON, raw, db, dirKind, name)
      }
      if (leaf === 'documents.jsonl') {
        return scope(ScopeLevel.DOCUMENTS, raw, db, dirKind, name)
      }
    }
    return scope(ScopeLevel.UNKNOWN, raw)
  }

  return scope(ScopeLevel.UNKNOWN, raw)
}
