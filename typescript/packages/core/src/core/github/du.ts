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
import type { GitHubAccessor } from '../../accessor/github.ts'
import type { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'

function strip(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  return stripSlash(p)
}

export function du(accessor: GitHubAccessor, path: PathSpec): Promise<number> {
  const key = strip(path)
  const prefix = key === '' ? '' : `${key}/`
  let total = 0
  for (const [p, entry] of Object.entries(accessor.tree)) {
    if (p === key || p.startsWith(prefix)) {
      total += entry.size ?? 0
    }
  }
  return Promise.resolve(total)
}

export function duAll(
  accessor: GitHubAccessor,
  path: PathSpec,
): Promise<[[string, number][], number]> {
  const key = strip(path)
  const prefix = key === '' ? '' : `${key}/`
  const out: [string, number][] = []
  let total = 0
  for (const [p, entry] of Object.entries(accessor.tree)) {
    if (p === key || p.startsWith(prefix)) {
      out.push([`/${p}`, entry.size ?? 0])
      total += entry.size ?? 0
    }
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return Promise.resolve([out, total])
}
