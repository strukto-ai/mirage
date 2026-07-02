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
import { fetchDatasetItems, fetchDatasetRuns, fetchPrompt, fetchTrace } from './_client.ts'
import { enoent } from '../../utils/errors.ts'

const ENC = new TextEncoder()

function toJsonBytes(data: unknown): Uint8Array {
  return ENC.encode(JSON.stringify(data, null, 2))
}

function toJsonlBytes(items: readonly Record<string, unknown>[]): Uint8Array {
  if (items.length === 0) return new Uint8Array()
  const text = items.map((item) => JSON.stringify(item)).join('\n') + '\n'
  return ENC.encode(text)
}

export async function read(
  accessor: LangfuseAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  const key = path.resourcePath
  if (key === '') throw enoent(path)
  const parts = key.split('/')
  for (const part of parts) {
    if (part.startsWith('.')) throw enoent(path)
  }

  if (parts[0] === 'traces' && parts.length === 2 && (parts[1] ?? '').endsWith('.json')) {
    const traceId = (parts[1] ?? '').slice(0, -'.json'.length)
    const data = await fetchTrace(accessor.transport, traceId)
    return toJsonBytes(data)
  }

  if (parts[0] === 'sessions' && parts.length === 3 && (parts[2] ?? '').endsWith('.json')) {
    const traceId = (parts[2] ?? '').slice(0, -'.json'.length)
    const data = await fetchTrace(accessor.transport, traceId)
    return toJsonBytes(data)
  }

  if (parts[0] === 'prompts' && parts.length === 3 && (parts[2] ?? '').endsWith('.json')) {
    const promptName = parts[1] ?? ''
    const versionStr = (parts[2] ?? '').slice(0, -'.json'.length)
    const version = Number.parseInt(versionStr, 10)
    if (Number.isNaN(version)) throw enoent(path)
    const data = await fetchPrompt(accessor.transport, promptName, version)
    return toJsonBytes(data)
  }

  if (parts[0] === 'datasets' && parts.length === 3 && parts[2] === 'items.jsonl') {
    const datasetName = parts[1] ?? ''
    const items = await fetchDatasetItems(accessor.transport, datasetName)
    return toJsonlBytes(items)
  }

  if (
    parts[0] === 'datasets' &&
    parts.length === 4 &&
    parts[2] === 'runs' &&
    (parts[3] ?? '').endsWith('.jsonl')
  ) {
    const datasetName = parts[1] ?? ''
    const runName = (parts[3] ?? '').slice(0, -'.jsonl'.length)
    const runs = await fetchDatasetRuns(accessor.transport, datasetName)
    const matched = runs.filter((r) => r.name === runName)
    const first = matched[0]
    if (first === undefined) throw enoent(path)
    return toJsonBytes(first)
  }

  throw enoent(path)
}
