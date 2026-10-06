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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { makeRead } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { jsonBytes, jsonlBytes } from '../render/json.ts'
import {
  fetchDatasetItems,
  fetchDatasetRuns,
  fetchOrEnoent,
  fetchPrompt,
  fetchTrace,
} from './client.ts'
import { detectScope } from './scope.ts'

/**
 * The trace a trace path names, or ENOENT.
 *
 * A trace is addressed by its id whatever the listing holds: the listing
 * stops at `defaultTraceLimit` and `defaultFromTimestamp`, and an older
 * trace is still the project's. Under `sessions/<id>/` the trace must be
 * that session's, so a path cannot name another session's trace. Mirrors
 * python's `fetch_trace_file`.
 */
export async function fetchTraceFile(
  accessor: LangfuseAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Record<string, unknown>> {
  const data = await fetchOrEnoent(fetchTrace(accessor.transport, match.slots.trace_id ?? ''), path)
  const sessionId = match.slots.session_id
  if (sessionId !== undefined && data.sessionId !== sessionId) throw enoent(path)
  return data
}

async function readTrace(
  accessor: LangfuseAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  return jsonBytes(await fetchTraceFile(accessor, match, path))
}

async function readPromptVersion(
  accessor: LangfuseAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  // The scope's codec only matches plain ASCII integers, so the parse here
  // cannot fail.
  const version = Number.parseInt(match.slots.version ?? '', 10)
  const data = await fetchOrEnoent(
    fetchPrompt(accessor.transport, match.slots.prompt_name ?? '', version),
    path,
  )
  return jsonBytes(data)
}

async function readDatasetItems(
  accessor: LangfuseAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const items = await fetchOrEnoent(
    fetchDatasetItems(accessor.transport, match.slots.dataset_name ?? ''),
    path,
  )
  return jsonlBytes(items)
}

async function readDatasetRun(
  accessor: LangfuseAccessor,
  match: ScopeMatch,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const runs = await fetchOrEnoent(
    fetchDatasetRuns(accessor.transport, match.slots.dataset_name ?? ''),
    path,
  )
  const runName = match.slots.run_name ?? ''
  const matched = runs.filter((r) => r.name === runName)
  const first = matched[0]
  if (first === undefined) throw enoent(path)
  // A .jsonl path must render as line-delimited JSON, not an indented
  // document: readers that split on newlines (jq) otherwise choke on the
  // first bare brace.
  return jsonlBytes([first])
}

export const read = makeRead(detectScope, {
  trace: readTrace,
  session_trace: readTrace,
  prompt_version: readPromptVersion,
  dataset_items: readDatasetItems,
  dataset_run: readDatasetRun,
})
