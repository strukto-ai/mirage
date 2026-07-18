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

import type { MongoDBAccessor } from '../../../accessor/mongodb.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { listDatabases } from '../../../core/mongodb/_client.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { MONGODB_CMD_OPS } from './ops.ts'
import { read as mongoRead } from '../../../core/mongodb/read.ts'
import { readdir as mongoReaddir } from '../../../core/mongodb/readdir.ts'
import { detectScope } from '../../../core/mongodb/scope.ts'
import {
  formatGrepResults,
  searchCollection,
  searchDatabase,
} from '../../../core/mongodb/search.ts'
import { stat as mongoStat } from '../../../core/mongodb/stat.ts'
import { ScopeLevel } from '../../../core/mongodb/types.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { grepGeneric } from '../generic/grep.ts'
import { patternArg } from '../grep_helper.ts'
import { formatRecords } from '../utils/output.ts'
import { searchProvision } from './_provision.ts'

const resolveGlob = resolveGlobOf(MONGODB_CMD_OPS)

async function* mongoStream(
  accessor: MongoDBAccessor,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await mongoRead(accessor, p, index)
}

async function grepCommand(
  accessor: MongoDBAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags)
  const limit = accessor.config.defaultSearchLimit

  const first = paths[0]
  if (first !== undefined && pattern !== null && !pattern.includes('\n')) {
    const scope = detectScope(first)

    if (scope.level !== ScopeLevel.ROOT) {
      await mongoStat(accessor, first, opts.index ?? undefined)
    }

    if (scope.level === ScopeLevel.ROOT) {
      const dbs = await listDatabases(accessor)
      const results: Awaited<ReturnType<typeof searchDatabase>> = []
      for (const db of dbs) {
        results.push(...(await searchDatabase(accessor, db, pattern, limit)))
      }
      const allLines = formatGrepResults(results)
      if (allLines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      return [formatRecords(allLines), new IOResult()]
    }

    if (scope.level === ScopeLevel.DATABASE && scope.database !== null) {
      const results = await searchDatabase(accessor, scope.database, pattern, limit)
      const allLines = formatGrepResults(results)
      if (allLines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      return [formatRecords(allLines), new IOResult()]
    }

    if (scope.level === ScopeLevel.ENTITY && scope.database !== null && scope.name !== null) {
      const docs = await searchCollection(accessor, scope.database, scope.name, pattern, limit)
      if (docs.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      const results = [{ database: scope.database, collection: scope.name, docs }]
      const allLines = formatGrepResults(results)
      return [formatRecords(allLines), new IOResult()]
    }
  }

  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => mongoStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    mongoReaddir(accessor, p, opts.index ?? undefined)
  return grepGeneric('grep', resolved, texts, opts, stat, readdir, (p) =>
    mongoStream(accessor, p, opts.index ?? undefined),
  )
}

export const MONGODB_GREP = command({
  name: 'grep',
  resource: ResourceName.MONGODB,
  spec: specOf('grep'),
  fn: grepCommand,
  provision: searchProvision,
})
