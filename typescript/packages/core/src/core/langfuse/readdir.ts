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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { LangfuseAccessor } from '../../accessor/langfuse.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import {
  fetchDatasetItems,
  fetchDatasetRuns,
  fetchDatasets,
  fetchPrompts,
  fetchSessions,
  fetchTraces,
} from './_client.ts'
import { toJsonlBytes } from './render.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

const TOP_LEVEL_DIRS = ['traces', 'sessions', 'prompts', 'datasets'] as const

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

function makeVirtualKey(prefix: string, key: string): string {
  if (key === '') return prefix !== '' ? prefix : '/'
  return `${prefix}/${key}`
}

async function readdirTraces(
  accessor: LangfuseAccessor,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const limit = accessor.config.defaultTraceLimit ?? DEFAULT_TRACE_LIMIT
  // No implicit time window: an unset defaultFromTimestamp lists whatever the
  // project holds, up to defaultTraceLimit. A rolling default would hide
  // traces that read() happily serves, and python applies no window either.
  const opts: { limit: number; fromTimestamp?: string } = { limit }
  const from = accessor.config.defaultFromTimestamp
  if (from !== undefined && from !== '') opts.fromTimestamp = from
  const traces = await fetchTraces(accessor.transport, opts)
  // The list endpoint returns trace summaries while a read renders the
  // full trace with its observations, so a size here would cost one
  // fetchTrace per entry. Traces and prompts stay size-unknown until a
  // read hydrates them; the dataset .jsonl files are sized because their
  // listing already carries every item.
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const t of traces) {
    const traceId = pickString(t, 'id')
    const filename = `${traceId}.json`
    entries.push([
      filename,
      new IndexEntry({
        id: traceId,
        name: traceId,
        resourceType: 'langfuse/trace',
        vfsName: filename,
      }),
    ])
    names.push(`${prefix}/traces/${filename}`)
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return names
}

async function readdirSessions(
  accessor: LangfuseAccessor,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const sessions = await fetchSessions(accessor.transport)
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const s of sessions) {
    const sessionId = pickString(s, 'id')
    entries.push([
      sessionId,
      new IndexEntry({
        id: sessionId,
        name: sessionId,
        resourceType: 'langfuse/session',
        vfsName: sessionId,
      }),
    ])
    names.push(`${prefix}/sessions/${sessionId}`)
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return names
}

async function readdirSessionTraces(
  accessor: LangfuseAccessor,
  sessionId: string,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const limit = accessor.config.defaultTraceLimit ?? DEFAULT_TRACE_LIMIT
  const opts: { sessionId: string; limit: number; fromTimestamp?: string } = { sessionId, limit }
  const from = accessor.config.defaultFromTimestamp
  if (from !== undefined && from !== '') opts.fromTimestamp = from
  const traces = await fetchTraces(accessor.transport, opts)
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const t of traces) {
    const traceId = pickString(t, 'id')
    const filename = `${traceId}.json`
    entries.push([
      filename,
      new IndexEntry({
        id: traceId,
        name: traceId,
        resourceType: 'langfuse/trace',
        vfsName: filename,
      }),
    ])
    names.push(`${prefix}/sessions/${sessionId}/${filename}`)
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return names
}

async function readdirPrompts(
  accessor: LangfuseAccessor,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const prompts = await fetchPrompts(accessor.transport)
  const seen = new Set<string>()
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const p of prompts) {
    const promptName = pickString(p, 'name')
    if (seen.has(promptName)) continue
    seen.add(promptName)
    entries.push([
      promptName,
      new IndexEntry({
        id: promptName,
        name: promptName,
        resourceType: 'langfuse/prompt',
        vfsName: promptName,
      }),
    ])
    names.push(`${prefix}/prompts/${promptName}`)
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return names
}

async function readdirPromptVersions(
  accessor: LangfuseAccessor,
  promptName: string,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const prompts = await fetchPrompts(accessor.transport)
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const p of prompts) {
    if (pickString(p, 'name') !== promptName) continue
    // The list endpoint returns PromptMeta, which carries every version of a
    // prompt in a `versions` array; there is no scalar `version`.
    for (const version of promptVersions(p)) {
      const filename = `${version}.json`
      entries.push([
        filename,
        new IndexEntry({
          id: `${promptName}/${version}`,
          name: version,
          resourceType: 'langfuse/prompt_version',
          vfsName: filename,
        }),
      ])
      names.push(`${prefix}/prompts/${promptName}/${filename}`)
    }
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return names
}

async function readdirDatasets(
  accessor: LangfuseAccessor,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const datasets = await fetchDatasets(accessor.transport)
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const d of datasets) {
    const datasetName = pickString(d, 'name')
    entries.push([
      datasetName,
      new IndexEntry({
        id: datasetName,
        name: datasetName,
        resourceType: 'langfuse/dataset',
        vfsName: datasetName,
      }),
    ])
    names.push(`${prefix}/datasets/${datasetName}`)
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return names
}

async function readdirDataset(
  accessor: LangfuseAccessor,
  datasetName: string,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  // One dataset_items call per dataset directory actually entered: the
  // dataset listing carries no item payloads, so items.jsonl can only be
  // sized here, and only for datasets the caller opens.
  const items = await fetchDatasetItems(accessor.transport, datasetName)
  const entries: [string, IndexEntry][] = [
    [
      'items.jsonl',
      new IndexEntry({
        id: `${datasetName}/items`,
        name: 'items.jsonl',
        resourceType: 'langfuse/dataset_items',
        vfsName: 'items.jsonl',
        size: toJsonlBytes(items).byteLength,
      }),
    ],
    [
      'runs',
      new IndexEntry({
        id: `${datasetName}/runs`,
        name: 'runs',
        resourceType: 'langfuse/dataset_runs_dir',
        vfsName: 'runs',
      }),
    ],
  ]
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return entries.map(([name]) => `${prefix}/datasets/${datasetName}/${name}`)
}

async function readdirDatasetRuns(
  accessor: LangfuseAccessor,
  datasetName: string,
  virtualKey: string,
  index: IndexCacheStore | undefined,
  prefix: string,
): Promise<string[]> {
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const runs = await fetchDatasetRuns(accessor.transport, datasetName)
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const r of runs) {
    const runName = pickString(r, 'name')
    const filename = `${runName}.jsonl`
    // The listing already carries the run document read() renders, so each
    // run file's exact size is free here.
    entries.push([
      filename,
      new IndexEntry({
        id: runName,
        name: runName,
        resourceType: 'langfuse/dataset_run',
        vfsName: filename,
        size: toJsonlBytes([r]).byteLength,
      }),
    ])
    names.push(`${prefix}/datasets/${datasetName}/runs/${filename}`)
  }
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return names
}

export async function readdir(
  accessor: LangfuseAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.pattern !== null ? path.directory : path.virtual
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  const key = stripSlash(p)
  for (const part of key.split('/')) {
    if (key !== '' && part.startsWith('.')) throw enoent(path)
  }
  const virtualKey = makeVirtualKey(prefix, key)

  if (key === '') {
    return TOP_LEVEL_DIRS.map((d) => `${prefix}/${d}`)
  }

  const parts = key.split('/')

  if (parts[0] === 'traces' && parts.length === 1) {
    return readdirTraces(accessor, virtualKey, index, prefix)
  }

  if (parts[0] === 'sessions' && parts.length === 1) {
    return readdirSessions(accessor, virtualKey, index, prefix)
  }

  if (parts[0] === 'sessions' && parts.length === 2) {
    return readdirSessionTraces(accessor, parts[1] ?? '', virtualKey, index, prefix)
  }

  if (parts[0] === 'prompts' && parts.length === 1) {
    return readdirPrompts(accessor, virtualKey, index, prefix)
  }

  if (parts[0] === 'prompts' && parts.length === 2) {
    return readdirPromptVersions(accessor, parts[1] ?? '', virtualKey, index, prefix)
  }

  if (parts[0] === 'datasets' && parts.length === 1) {
    return readdirDatasets(accessor, virtualKey, index, prefix)
  }

  if (parts[0] === 'datasets' && parts.length === 2) {
    return readdirDataset(accessor, parts[1] ?? '', virtualKey, index, prefix)
  }

  if (parts[0] === 'datasets' && parts.length === 3 && parts[2] === 'runs') {
    return readdirDatasetRuns(accessor, parts[1] ?? '', virtualKey, index, prefix)
  }

  throw enoent(path)
}
