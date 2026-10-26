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

import type { GitHubTransport } from './client.ts'

export async function githubPages(
  transport: GitHubTransport,
  path: string,
  opts: {
    params?: Record<string, string>
    limit?: number
    key?: string
    include?: (row: Record<string, unknown>) => boolean
  } = {},
): Promise<Record<string, unknown>[]> {
  const limit = opts.limit ?? 30
  if (limit < 1) return []
  const rows: Record<string, unknown>[] = []
  let page = 1
  const size = Math.min(100, limit)
  while (rows.length < limit) {
    const data = await transport.get(path, {
      ...(opts.params ?? {}),
      per_page: String(size),
      page: String(page),
    })
    const payload =
      opts.key !== undefined && data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)[opts.key]
        : data
    const batch = Array.isArray(payload)
      ? payload.filter(
          (item): item is Record<string, unknown> => item !== null && typeof item === 'object',
        )
      : []
    for (const item of batch.filter((row) => opts.include?.(row) ?? true)) rows.push(item)
    if (batch.length < size) break
    page += 1
  }
  return rows.slice(0, limit)
}
