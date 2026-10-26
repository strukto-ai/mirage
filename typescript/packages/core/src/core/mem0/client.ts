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

import type { Mem0Accessor } from '../../accessor/mem0.ts'

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : []
}

/** Fetch all memories for the configured scope, following pagination. */
export async function getAllMemories(
  accessor: Mem0Accessor,
  limit?: number,
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = []
  let page = 1
  for (;;) {
    const response = await accessor.request('POST', '/v3/memories/', {
      params: { page, page_size: accessor.config.defaultPageSize },
      json: { filters: accessor.config.scopeFilter },
    })
    const batch = records(response.results)
    for (const item of batch) results.push(item)
    if (!response.next || batch.length === 0) return results
    if (limit !== undefined && results.length >= limit) return results
    page += 1
  }
}

/** Semantic search within the configured scope. */
export async function searchMemories(
  accessor: Mem0Accessor,
  query: string,
  topK: number,
  threshold: number,
): Promise<Record<string, unknown>[]> {
  const response = await accessor.request('POST', '/v3/memories/search/', {
    json: { query, filters: accessor.config.scopeFilter, top_k: topK, threshold },
  })
  return records(response.results)
}
