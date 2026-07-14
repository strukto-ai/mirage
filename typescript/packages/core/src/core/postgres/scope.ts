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
import { stripSlash } from '../../utils/slash.ts'

type EntityKind = 'tables' | 'views'

export type PostgresScope =
  | { level: 'root'; resourcePath: string }
  | { level: 'database_json'; file: 'database.json'; resourcePath: string }
  | { level: 'schema'; schema: string; resourcePath: string }
  | { level: 'kind'; schema: string; kind: EntityKind; resourcePath: string }
  | {
      level: 'entity'
      schema: string
      kind: EntityKind
      entity: string
      resourcePath: string
    }
  | {
      level: 'entity_schema'
      schema: string
      kind: EntityKind
      entity: string
      file: 'schema.json'
      resourcePath: string
    }
  | {
      level: 'entity_rows'
      schema: string
      kind: EntityKind
      entity: string
      file: 'rows.jsonl'
      resourcePath: string
    }
  | { level: 'invalid'; resourcePath: string }

export function detectScope(path: PathSpec | string): PostgresScope {
  const raw = path instanceof PathSpec ? path.mountPath : path
  const key = stripSlash(raw)

  if (key === '') {
    return { level: 'root', resourcePath: '/' }
  }

  if (key === 'database.json') {
    return { level: 'database_json', file: 'database.json', resourcePath: raw }
  }

  const parts = key.split('/')
  const schema = parts[0]
  if (schema === undefined) {
    return { level: 'invalid', resourcePath: raw }
  }

  if (parts.length === 1) {
    return { level: 'schema', schema, resourcePath: raw }
  }

  const kindRaw = parts[1]
  if (kindRaw !== 'tables' && kindRaw !== 'views') {
    return { level: 'invalid', resourcePath: raw }
  }
  const kind: EntityKind = kindRaw

  if (parts.length === 2) {
    return { level: 'kind', schema, kind, resourcePath: raw }
  }

  const entity = parts[2]
  if (entity === undefined) {
    return { level: 'invalid', resourcePath: raw }
  }

  if (parts.length === 3) {
    return { level: 'entity', schema, kind, entity, resourcePath: raw }
  }

  if (parts.length === 4) {
    const file = parts[3]
    if (file === 'schema.json') {
      return {
        level: 'entity_schema',
        schema,
        kind,
        entity,
        file: 'schema.json',
        resourcePath: raw,
      }
    }
    if (file === 'rows.jsonl') {
      return {
        level: 'entity_rows',
        schema,
        kind,
        entity,
        file: 'rows.jsonl',
        resourcePath: raw,
      }
    }
  }

  return { level: 'invalid', resourcePath: raw }
}
