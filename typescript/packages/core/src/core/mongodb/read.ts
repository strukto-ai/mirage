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

import type { MongoDBAccessor } from '../../accessor/mongodb.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { databaseExists, entityExists } from './_client.ts'
import { buildCollectionSchemaJson, buildDatabaseJson } from './_schema_json.ts'
import { detectScope } from './scope.ts'
import { readStream } from './stream.ts'
import { ScopeLevel } from './types.ts'

function notFound(p: string): Error {
  const err = new Error(p) as Error & { code?: string }
  err.code = 'ENOENT'
  return err
}

export async function read(
  accessor: MongoDBAccessor,
  path: PathSpec | string,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const scope = detectScope(spec)

  if (scope.level === ScopeLevel.DOCUMENTS && scope.database !== null && scope.name !== null) {
    if (!(await entityExists(accessor, scope.database, scope.name, scope.kind))) {
      throw notFound(spec.original)
    }
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of readStream(accessor, spec)) {
      chunks.push(chunk)
      total += chunk.byteLength
    }
    const buf = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      buf.set(c, off)
      off += c.byteLength
    }
    return buf
  }

  if (scope.level === ScopeLevel.SCHEMA_JSON && scope.database !== null && scope.name !== null) {
    if (!(await entityExists(accessor, scope.database, scope.name, scope.kind))) {
      throw notFound(spec.original)
    }
    const payload = await buildCollectionSchemaJson(accessor, scope.database, scope.name)
    return new TextEncoder().encode(JSON.stringify(payload) + '\n')
  }

  if (scope.level === ScopeLevel.DATABASE_JSON && scope.database !== null) {
    if (!(await databaseExists(accessor, scope.database))) throw notFound(spec.original)
    const payload = await buildDatabaseJson(accessor, scope.database)
    return new TextEncoder().encode(JSON.stringify(payload) + '\n')
  }

  throw notFound(spec.original)
}
