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
import type { PathSpec } from '../../types.ts'
import { makeRead } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { buildCollectionSchemaJson, buildDatabaseJson } from './_schema_json.ts'
import { databaseGuard, entityGuard } from './readdir.ts'
import { detectScope } from './scope.ts'
import { readStream, stringifyDoc } from './stream.ts'

export async function* streamAny(
  accessor: MongoDBAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const scope = detectScope(path)
  if (scope.kind === 'documents') {
    yield* readStream(accessor, path)
    return
  }
  yield await read(accessor, path, index)
}

async function readDocuments(
  accessor: MongoDBAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of readStream(accessor, path)) {
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

async function readSchemaJson(
  accessor: MongoDBAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  await entityGuard(accessor, match, path.virtual)
  const payload = await buildCollectionSchemaJson(
    accessor,
    match.slots.database ?? '',
    match.slots.name ?? '',
  )
  return new TextEncoder().encode(
    stringifyDoc(payload as unknown as Record<string, unknown>) + '\n',
  )
}

async function readDatabaseJson(
  accessor: MongoDBAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  await databaseGuard(accessor, match, path.virtual)
  const payload = await buildDatabaseJson(accessor, match.slots.database ?? '')
  return new TextEncoder().encode(
    stringifyDoc(payload as unknown as Record<string, unknown>) + '\n',
  )
}

export const read = makeRead<MongoDBAccessor>(detectScope, {
  documents: readDocuments,
  schema_json: readSchemaJson,
  database_json: readDatabaseJson,
})
