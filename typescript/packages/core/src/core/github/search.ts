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

import type { GitHubAccessor } from '../../accessor/github.ts'
import { PathSpec } from '../../types.ts'
import { lstripSlash, stripSlash } from '../../utils/slash.ts'
import { type GitHubCodeSearchResult, searchCode } from './_client.ts'

export type { GitHubCodeSearchResult } from './_client.ts'

export async function search(
  accessor: GitHubAccessor,
  query: string,
  pathFilter?: string,
): Promise<GitHubCodeSearchResult[]> {
  return searchCode(accessor.transport, accessor.owner, accessor.repo, query, pathFilter)
}

function stripPrefix(p: PathSpec): string {
  const prefix = p.prefix
  let raw = p.original
  if (prefix !== '' && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length) || '/'
  }
  return raw
}

export async function narrowPaths(
  accessor: GitHubAccessor,
  pattern: string,
  paths: readonly PathSpec[],
): Promise<PathSpec[]> {
  const mountPrefix = paths[0]?.prefix ?? ''
  const narrowed: string[] = []
  for (const p of paths) {
    const pathFilter = stripSlash(stripPrefix(p))
    try {
      const results = await search(accessor, pattern, pathFilter === '' ? undefined : pathFilter)
      const scopePrefix = pathFilter === '' ? '' : `${pathFilter}/`
      for (const r of results) {
        if (r.path === pathFilter || r.path.startsWith(scopePrefix)) narrowed.push(r.path)
      }
    } catch {
      // ignore — search is best-effort
    }
  }
  return narrowed.map(
    (n) =>
      new PathSpec({
        original: `${mountPrefix}/${lstripSlash(n)}`,
        directory: '',
        prefix: mountPrefix,
        resolved: true,
      }),
  )
}
