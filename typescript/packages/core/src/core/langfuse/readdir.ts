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

import type { LangfuseAccessor } from '../../accessor/langfuse.ts'
import { DirListing, FileStat, FileType } from '../../types.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { jsonlBytes } from '../render/json.ts'
import {
  fetchDatasetItems,
  fetchDatasetRuns,
  fetchDatasets,
  fetchPrompts,
  fetchSessions,
  fetchTraces,
} from './client.ts'
import { TOP_LEVEL_DIRS, detectScope } from './scope.ts'

// Mirrors LangfuseConfig.default_trace_limit in python.
const DEFAULT_TRACE_LIMIT = 100

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function promptVersions(record: Record<string, unknown>): string[] {
  const value = record.versions
  if (!Array.isArray(value)) return []
  const numbers: number[] = []
  for (const entry of value) {
    const parsed = typeof entry === 'number' ? entry : Number(entry)
    if (Number.isFinite(parsed)) numbers.push(parsed)
  }
  return numbers.sort((a, b) => a - b).map(String)
}

/**
 * Whether a trace listing may have left traces out.
 *
 * It is one page of at most `defaultTraceLimit` traces from
 * `defaultFromTimestamp` on, so a full page or a set window is a truncated
 * view, not the directory: cached as complete it would prove an older
 * trace absent while read fetches it by id. Mirrors python's `_bounded`.
 */
function bounded(accessor: LangfuseAccessor, traces: readonly Record<string, unknown>[]): boolean {
  const limit = accessor.config.defaultTraceLimit ?? DEFAULT_TRACE_LIMIT
  const from = accessor.config.defaultFromTimestamp
  return traces.length >= limit || (from !== undefined && from !== '')
}

function sessionExtra(match: ScopeMatch): Record<string, string> {
  return { session_id: match.slots.session_id ?? '' }
}

function promptExtra(match: ScopeMatch): Record<string, string> {
  return { prompt_name: match.slots.prompt_name ?? '' }
}

function datasetExtra(match: ScopeMatch): Record<string, string> {
  return { dataset_name: match.slots.dataset_name ?? '' }
}

// What each kind's stat carries in `extra`, listed or not.
export const EXTRAS = {
  session: sessionExtra,
  prompt: promptExtra,
  dataset: datasetExtra,
}

function dirs(names: readonly string[]): FileStat[] {
  return names.map((name) => new FileStat({ name, type: FileType.DIRECTORY }))
}

function traceRows(roots: readonly Record<string, unknown>[]): FileStat[] {
  // A trace can hold more than one root observation.
  const ids = new Set(roots.map((r) => pickString(r, 'traceId')))
  return [...ids].map((id) => new FileStat({ name: `${id}.json`, type: FileType.FILE }))
}

async function listTraces(accessor: LangfuseAccessor, _match: ScopeMatch): Promise<DirListing> {
  // No implicit time window: an unset defaultFromTimestamp lists whatever the
  // project holds, up to defaultTraceLimit. A rolling default would hide
  // traces that read() happily serves, and python applies no window either.
  const traces = await fetchTraces(accessor.transport, {
    limit: accessor.config.defaultTraceLimit ?? DEFAULT_TRACE_LIMIT,
    fromTimestamp: accessor.config.defaultFromTimestamp,
  })
  // The listing carries root observations while a read renders the whole
  // trace with its observations and scores, so a size here would cost one
  // fetchTrace per entry. Traces and prompts stay size-unknown until a read
  // hydrates them; the dataset .jsonl files are sized because their listing
  // already carries every item.
  return new DirListing({ entries: traceRows(traces), partial: bounded(accessor, traces) })
}

async function listSessions(accessor: LangfuseAccessor, _match: ScopeMatch): Promise<DirListing> {
  // The sessions of one page of the newest traces: an older one that drops
  // off it has not been deleted, so the listing evicts nothing.
  const sessions = await fetchSessions(accessor.transport, {
    limit: accessor.config.defaultTraceLimit ?? DEFAULT_TRACE_LIMIT,
    fromTimestamp: accessor.config.defaultFromTimestamp,
  })
  return new DirListing({ entries: dirs(sessions), window: true })
}

async function listSessionTraces(
  accessor: LangfuseAccessor,
  match: ScopeMatch,
): Promise<DirListing> {
  const traces = await fetchTraces(accessor.transport, {
    sessionId: match.slots.session_id ?? '',
    limit: accessor.config.defaultTraceLimit ?? DEFAULT_TRACE_LIMIT,
    fromTimestamp: accessor.config.defaultFromTimestamp,
  })
  return new DirListing({ entries: traceRows(traces), partial: bounded(accessor, traces) })
}

async function listPrompts(accessor: LangfuseAccessor, _match: ScopeMatch): Promise<DirListing> {
  const prompts = await fetchPrompts(accessor.transport)
  const names = [...new Set(prompts.map((p) => pickString(p, 'name')))]
  return new DirListing({ entries: dirs(names), window: true })
}

async function listPromptVersions(
  accessor: LangfuseAccessor,
  match: ScopeMatch,
): Promise<FileStat[]> {
  const promptName = match.slots.prompt_name ?? ''
  const prompts = await fetchPrompts(accessor.transport)
  const rows: FileStat[] = []
  for (const p of prompts) {
    if (pickString(p, 'name') !== promptName) continue
    // The list endpoint returns PromptMeta, which carries every version of a
    // prompt in a `versions` array; there is no scalar `version`.
    for (const version of promptVersions(p)) {
      rows.push(new FileStat({ name: `${version}.json`, type: FileType.FILE }))
    }
  }
  return rows
}

async function listDatasets(accessor: LangfuseAccessor, _match: ScopeMatch): Promise<DirListing> {
  const datasets = await fetchDatasets(accessor.transport)
  return new DirListing({
    entries: dirs(datasets.map((d) => pickString(d, 'name'))),
    window: true,
  })
}

async function listDataset(accessor: LangfuseAccessor, match: ScopeMatch): Promise<FileStat[]> {
  // One dataset_items call per dataset directory actually entered: the
  // dataset listing carries no item payloads, so items.jsonl can only be
  // sized here, and only for datasets the caller opens.
  const items = await fetchDatasetItems(accessor.transport, match.slots.dataset_name ?? '')
  return [
    new FileStat({ name: 'items.jsonl', type: FileType.FILE, size: jsonlBytes(items).byteLength }),
    new FileStat({ name: 'runs', type: FileType.DIRECTORY }),
  ]
}

async function listDatasetRuns(accessor: LangfuseAccessor, match: ScopeMatch): Promise<DirListing> {
  const runs = await fetchDatasetRuns(accessor.transport, match.slots.dataset_name ?? '')
  // The listing already carries the run document read() renders, so each run
  // file's exact size is free here.
  const rows = runs.map(
    (r) =>
      new FileStat({
        name: `${pickString(r, 'name')}.jsonl`,
        type: FileType.FILE,
        size: jsonlBytes([r]).byteLength,
      }),
  )
  return new DirListing({ entries: rows, window: true })
}

export const readdir = makeReaddir<LangfuseAccessor>(detectScope, {
  listers: {
    traces: listTraces,
    sessions: listSessions,
    session: listSessionTraces,
    prompts: listPrompts,
    prompt: listPromptVersions,
    datasets: listDatasets,
    dataset: listDataset,
    runs: listDatasetRuns,
  },
  staticRoot: TOP_LEVEL_DIRS,
  extras: EXTRAS,
})
