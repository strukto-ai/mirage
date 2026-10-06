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

import type { SearchQuery } from '../../vfs/types.ts'
import { validateOptions, intOption, floatOption, textOption } from '../../vfs/search.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { PathSpec } from '../../types.ts'
import { readdir } from './readdir.ts'
import { makeResolveGlob } from '../../utils/glob_walk.ts'
import { detectScope } from './scope.ts'
import { enoent } from '../../utils/errors.ts'
import type { Mem0Accessor } from '../../accessor/mem0.ts'
import { formatScore } from '../../utils/score.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { searchMemories } from './client.ts'

const ENCODER = new TextEncoder()

function validate(query: string, topK: number, threshold: number): void {
  if (query === '') throw new Error('search: query is required')
  if (!Number.isInteger(topK) || topK <= 0) throw new Error('search: top-k must be positive')
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('search: threshold must be in [0, 1]')
  }
}

/**
 * Run a semantic search in the scope and render ranked results.
 *
 * `memoryIds` is an optional result id allowlist.
 */
export async function searchMemoriesRendered(
  accessor: Mem0Accessor,
  query: string,
  mountPrefix: string,
  topK: number,
  threshold: number,
  memoryIds?: ReadonlySet<string>,
): Promise<Uint8Array> {
  validate(query, topK, threshold)
  const lines: string[] = []
  for (const result of await searchMemories(accessor, query, topK, threshold)) {
    const id = String(result.id)
    if (memoryIds !== undefined && !memoryIds.has(id)) continue
    const path = `${rstripSlash(mountPrefix)}/${id}.json`
    const score = formatScore(result.score)
    const memory = typeof result.memory === 'string' ? result.memory : ''
    lines.push(`${score === null ? path : `${path}:${score}`}\n${memory}`)
  }
  return ENCODER.encode(lines.length === 0 ? '' : `${lines.join('\n')}\n`)
}

export async function searchMany(
  accessor: Mem0Accessor,
  paths: PathSpec[],
  query: SearchQuery,
  index?: IndexCacheStore,
): Promise<string[]> {
  validateOptions(query, ['top_k', 'threshold', 'method'])
  const topK = intOption(query, 'top_k', accessor.config.defaultSearchLimit)
  const first = paths[0]
  if (first === undefined) throw new Error('search: at least one scope is required')
  const prefix = mountPrefixOf(first.virtual, first.vfsPath)
  const method = textOption(query, 'method', 'semantic')
  const threshold = floatOption(query, 'threshold', 0)
  if (method !== 'semantic') throw new Error("search: only the 'semantic' method is supported")
  const all = paths.some((p) => stripSlash(p.vfsPath) === '')
  const targets = all ? [] : await makeResolveGlob(readdir)(accessor, paths, index)
  const ids = all ? undefined : new Set<string>()
  for (const path of targets) {
    const match = detectScope(path)
    if (match.kind !== 'memory') throw enoent(path)
    ids?.add(match.slots.memory_id ?? '')
  }
  const output = await searchMemoriesRendered(accessor, query.query, prefix, topK, threshold, ids)
  return output.length === 0 ? [] : new TextDecoder().decode(output).replace(/\n$/, '').split('\n')
}

export function searchResource(
  accessor: Mem0Accessor,
  path: PathSpec,
  query: SearchQuery,
  index?: IndexCacheStore,
): Promise<string[]> {
  return searchMany(accessor, [path], query, index)
}
