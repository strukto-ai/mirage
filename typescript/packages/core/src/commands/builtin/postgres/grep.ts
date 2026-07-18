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

import type { PostgresAccessor } from '../../../accessor/postgres.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { POSTGRES_CMD_OPS } from './ops.ts'
import { read as postgresRead } from '../../../core/postgres/read.ts'
import { readdir as postgresReaddir } from '../../../core/postgres/readdir.ts'
import { detectScope } from '../../../core/postgres/scope.ts'
import {
  formatGrepResults,
  searchDatabase,
  searchEntity,
  searchKind,
  searchSchema,
} from '../../../core/postgres/search.ts'
import { stat as postgresStat } from '../../../core/postgres/stat.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { grepGeneric } from '../generic/grep.ts'
import { patternArg } from '../grep_helper.ts'
import { formatRecords } from '../utils/output.ts'
import { searchProvision } from './_provision.ts'

const resolveGlob = resolveGlobOf(POSTGRES_CMD_OPS)

async function* postgresStream(
  accessor: PostgresAccessor,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await postgresRead(accessor, p, index)
}

async function grepCommand(
  accessor: PostgresAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags)
  const limit = accessor.config.defaultSearchLimit

  const first = paths[0]
  if (first !== undefined && pattern !== null && !pattern.includes('\n')) {
    const scope = detectScope(first)

    if (scope.level !== 'root') {
      await postgresStat(accessor, first, opts.index ?? undefined)
    }

    if (scope.level === 'root') {
      const results = await searchDatabase(accessor, pattern, limit)
      const allLines = formatGrepResults(results)
      if (allLines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      return [formatRecords(allLines), new IOResult()]
    }

    if (scope.level === 'schema') {
      const results = await searchSchema(accessor, scope.schema, pattern, limit)
      const allLines = formatGrepResults(results)
      if (allLines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      return [formatRecords(allLines), new IOResult()]
    }

    if (scope.level === 'kind') {
      const results = await searchKind(accessor, scope.schema, scope.kind, pattern, limit)
      const allLines = formatGrepResults(results)
      if (allLines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      return [formatRecords(allLines), new IOResult()]
    }

    if (scope.level === 'entity' || scope.level === 'entity_rows') {
      const rows = await searchEntity(
        accessor,
        scope.schema,
        scope.kind,
        scope.entity,
        pattern,
        limit,
      )
      if (rows.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      const results = [{ schema: scope.schema, kind: scope.kind, entity: scope.entity, rows }]
      const allLines = formatGrepResults(results)
      return [formatRecords(allLines), new IOResult()]
    }
  }

  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> =>
    postgresStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    postgresReaddir(accessor, p, opts.index ?? undefined)
  return grepGeneric('grep', resolved, texts, opts, stat, readdir, (p) =>
    postgresStream(accessor, p, opts.index ?? undefined),
  )
}

export const POSTGRES_GREP = command({
  name: 'grep',
  resource: ResourceName.POSTGRES,
  spec: specOf('grep'),
  fn: grepCommand,
  provision: searchProvision,
})
