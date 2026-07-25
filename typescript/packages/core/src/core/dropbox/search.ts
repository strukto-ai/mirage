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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import { PathSpec } from '../../types.ts'
import { rebaseRaw } from '../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { searchFiles } from './api.ts'
import { dropboxPathOf } from './paths.ts'

function compareComponents(a: string, b: string): number {
  const ca = a.split('/')
  const cb = b.split('/')
  const n = Math.min(ca.length, cb.length)
  for (let i = 0; i < n; i += 1) {
    const x = ca[i] ?? ''
    const y = cb[i] ?? ''
    if (x < y) return -1
    if (x > y) return 1
  }
  return ca.length - cb.length
}

/**
 * Use Dropbox file search to narrow grep/rg scopes to candidate files.
 *
 * Search results are compared against each scope on `path_lower` (Dropbox
 * paths are case-insensitive) and mapped back to mount paths from
 * `path_display`. Per-scope results are sorted component-wise so they line
 * up with the order a sorted readdir walk would visit, and each `rawPath`
 * is rebased onto the scope's as-typed spelling so output labels match a
 * walk's.
 *
 * Returns null whenever the narrowed set cannot be trusted as a superset
 * of what a full scan would read (API failure, or the 10,000-match search
 * ceiling), so the caller falls back to the full scan.
 */
export async function narrowPaths(
  accessor: DropboxAccessor,
  query: string,
  paths: readonly PathSpec[],
): Promise<PathSpec[] | null> {
  const first = paths[0]
  if (first === undefined) return []
  const mountPrefix = mountPrefixOf(first.virtual, first.resourcePath)
  const root = accessor.rootPath
  const narrowed: PathSpec[] = []
  for (const p of paths) {
    const scopeApi = dropboxPathOf(accessor, p)
    let results: [string, string][]
    try {
      const out = await searchFiles(accessor.tokenManager, query, { path: scopeApi })
      if (out.truncated) return null
      results = out.paths
    } catch {
      // Search is best-effort; an API failure falls back to the full scan.
      return null
    }
    const scopeLower = scopeApi.toLowerCase()
    const scopePrefix = rstripSlash(scopeLower) + '/'
    const scoped: string[] = []
    for (const [lower, display] of results) {
      if (lower !== scopeLower && !lower.startsWith(scopePrefix)) continue
      const key = stripSlash(display.slice(root.length))
      scoped.push(key === '' ? mountPrefix || '/' : `${mountPrefix}/${key}`)
    }
    scoped.sort(compareComponents)
    for (const virtual of scoped) {
      narrowed.push(
        new PathSpec({
          virtual,
          directory: '',
          resourcePath: mountKey(virtual, mountPrefix),
          resolved: true,
          rawPath: rebaseRaw([virtual], p.virtual, p.rawPath)[0] ?? virtual,
        }),
      )
    }
  }
  return narrowed
}
