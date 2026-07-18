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

import type { LangfuseAccessor } from '../../../accessor/langfuse.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import {
  fetchDatasets,
  fetchPrompts,
  fetchSessions,
  fetchTraces,
} from '../../../core/langfuse/_client.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { LANGFUSE_IO } from './io.ts'
import { read as langfuseRead } from '../../../core/langfuse/read.ts'
import { readdir as langfuseReaddir } from '../../../core/langfuse/readdir.ts'
import { detectScope } from '../../../core/langfuse/scope.ts'
import { stat as langfuseStat } from '../../../core/langfuse/stat.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { grepGeneric } from '../generic/grep.ts'
import { compilePattern, patternArg } from '../grep_helper.ts'
import { formatRecords } from '../utils/output.ts'
import { fileReadProvision } from './_provision.ts'

const resolveLangfuseGlob = resolveGlobOf(LANGFUSE_IO)

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function filterTraces(
  traces: readonly Record<string, unknown>[],
  pattern: RegExp,
): CommandFnResult {
  const lines: string[] = []
  for (const t of traces) {
    const traceId = pickString(t, 'id')
    const lineJson = JSON.stringify(t)
    if (!pattern.test(lineJson)) continue
    lines.push(`traces/${traceId}.json:${lineJson}`)
  }
  if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
  return [formatRecords(lines), new IOResult()]
}

function filterSessions(
  sessions: readonly Record<string, unknown>[],
  pattern: RegExp,
): CommandFnResult {
  const lines: string[] = []
  for (const s of sessions) {
    const sessionId = pickString(s, 'id')
    if (!pattern.test(sessionId)) continue
    const lineJson = JSON.stringify(s)
    lines.push(`sessions/${sessionId}:${lineJson}`)
  }
  if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
  return [formatRecords(lines), new IOResult()]
}

function filterPrompts(
  prompts: readonly Record<string, unknown>[],
  pattern: RegExp,
): CommandFnResult {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const p of prompts) {
    const promptName = pickString(p, 'name')
    if (seen.has(promptName)) continue
    if (!pattern.test(promptName)) continue
    seen.add(promptName)
    const lineJson = JSON.stringify(p)
    lines.push(`prompts/${promptName}:${lineJson}`)
  }
  if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
  return [formatRecords(lines), new IOResult()]
}

function filterDatasets(
  datasets: readonly Record<string, unknown>[],
  pattern: RegExp,
): CommandFnResult {
  const lines: string[] = []
  for (const d of datasets) {
    const datasetName = pickString(d, 'name')
    if (!pattern.test(datasetName)) continue
    const lineJson = JSON.stringify(d)
    lines.push(`datasets/${datasetName}:${lineJson}`)
  }
  if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
  return [formatRecords(lines), new IOResult()]
}

async function* langfuseStream(
  accessor: LangfuseAccessor,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await langfuseRead(accessor, p, index)
}

async function grepCommand(
  accessor: LangfuseAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags)
  const limit = accessor.config.defaultSearchLimit ?? 50

  const first = paths[0]
  if (first !== undefined && pattern !== null && !pattern.includes('\n')) {
    const scope = detectScope(first)
    const ignoreCase = opts.flags.i === true
    const fixedString = opts.flags.F === true
    const wholeWord = opts.flags.w === true
    const pat = compilePattern(pattern, ignoreCase, fixedString, wholeWord)
    if (scope.level === 'traces' || scope.level === 'root') {
      const traces = await fetchTraces(accessor.transport, { limit })
      return filterTraces(traces, pat)
    }
    if (scope.level === 'sessions') {
      const sessions = await fetchSessions(accessor.transport, { limit })
      return filterSessions(sessions, pat)
    }
    if (scope.level === 'prompts') {
      const prompts = await fetchPrompts(accessor.transport)
      return filterPrompts(prompts, pat)
    }
    if (scope.level === 'datasets') {
      const datasets = await fetchDatasets(accessor.transport)
      return filterDatasets(datasets, pat)
    }
  }

  const resolved =
    paths.length > 0 ? await resolveLangfuseGlob(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> =>
    langfuseStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    langfuseReaddir(accessor, p, opts.index ?? undefined)
  return grepGeneric('grep', resolved, texts, opts, stat, readdir, (p) =>
    langfuseStream(accessor, p, opts.index ?? undefined),
  )
}

export const LANGFUSE_GREP = command({
  name: 'grep',
  resource: ResourceName.LANGFUSE,
  spec: specOf('grep'),
  fn: grepCommand,
  provision: fileReadProvision,
})
