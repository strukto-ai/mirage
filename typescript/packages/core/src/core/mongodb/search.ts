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

import type { SearchResult } from '../../vfs/types.ts'
import type { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { PathSpec } from '../../types.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { queryMatcher, type LineMatcher, type Searcher } from '../hierarchy/search.ts'
import { buildCollectionSchemaJson, buildDatabaseJson } from './_schema_json.ts'
import { listCollections, listDatabases } from './client.ts'
import { entityKind } from './scope.ts'
import { readStream, stringifyDoc } from './stream.ts'
import { EntityKind, KIND_TO_DIR } from './types.ts'

// A directory's answer is grep -r's over the files under it, spelled relative
// to the mount, in the order a walk visits them (sorted, so `collections/` <
// `database.json` < `views/`, and within an entity `documents.jsonl` <
// `schema.json`). Each file is rendered exactly as `cat` renders it and decided
// by the matcher grep compiles, which is the only answer a schemaless
// collection can prove: the server-side $regex this replaced saw only string
// fields found in a 100-document sample, folded case whatever -i said, skipped
// views and the metadata files, and stopped at `defaultSearchLimit` documents
// per collection. Mirrors `mirage/core/mongodb/search.py`.

const DEC = new TextDecoder()

function matched(rel: string, text: string, matcher: LineMatcher): SearchResult[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
    .filter((line) => matcher(line))
    .map((line) => [PathSpec.fromStrPath(`/${rel}`), `${rel}:${line}`])
}

async function entityLines(
  accessor: MongoDBAccessor,
  database: string,
  kind: EntityKind,
  name: string,
  matcher: LineMatcher,
): Promise<SearchResult[]> {
  const rel = `${database}/${KIND_TO_DIR[kind]}/${name}`
  const docs = `${rel}/documents.jsonl`
  const lines: SearchResult[] = []
  const path = new PathSpec({ virtual: `/${docs}`, directory: `/${rel}`, vfsPath: docs })
  for await (const chunk of readStream(accessor, path)) {
    lines.push(...matched(docs, DEC.decode(chunk), matcher))
  }
  const schema = await buildCollectionSchemaJson(accessor, database, name)
  lines.push(
    ...matched(
      `${rel}/schema.json`,
      stringifyDoc(schema as unknown as Record<string, unknown>),
      matcher,
    ),
  )
  return lines
}

async function kindLines(
  accessor: MongoDBAccessor,
  database: string,
  kind: EntityKind,
  matcher: LineMatcher,
): Promise<SearchResult[]> {
  const lines: SearchResult[] = []
  for (const name of await listCollections(accessor, database, kind)) {
    for (const line of await entityLines(accessor, database, kind, name, matcher)) {
      lines.push(line)
    }
  }
  return lines
}

async function databaseLines(
  accessor: MongoDBAccessor,
  database: string,
  matcher: LineMatcher,
): Promise<SearchResult[]> {
  const payload = stringifyDoc(
    (await buildDatabaseJson(accessor, database)) as unknown as Record<string, unknown>,
  )
  return [
    ...(await kindLines(accessor, database, EntityKind.COLLECTION, matcher)),
    ...matched(`${database}/database.json`, payload, matcher),
    ...(await kindLines(accessor, database, EntityKind.VIEW, matcher)),
  ]
}

const entitySearcher: Searcher<MongoDBAccessor> = (accessor, match: ScopeMatch, query) =>
  entityLines(
    accessor,
    match.slots.database ?? '',
    entityKind(match),
    match.slots.name ?? '',
    queryMatcher(query),
  )

const databaseSearcher: Searcher<MongoDBAccessor> = (accessor, match, query) =>
  databaseLines(accessor, match.slots.database ?? '', queryMatcher(query))

const rootSearcher: Searcher<MongoDBAccessor> = async (accessor, _match, query) => {
  const matcher = queryMatcher(query)
  const lines: SearchResult[] = []
  for (const database of await listDatabases(accessor)) {
    for (const line of await databaseLines(accessor, database, matcher)) {
      lines.push(line)
    }
  }
  return lines
}

export const SEARCHERS: Readonly<Record<string, Searcher<MongoDBAccessor>>> = {
  root: rootSearcher,
  database: databaseSearcher,
  entity: entitySearcher,
}
