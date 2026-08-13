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

import type { HiddenPaths, HiddenVars } from '../types.ts'
import { fnmatch } from './fnmatch.ts'
import { stripSlash } from './slash.ts'

function normAbs(path: string): string {
  const stripped = stripSlash(path)
  return stripped === '' ? '/' : '/' + stripped
}

/**
 * Whether the session's spec hides this virtual path.
 *
 * The two planes of the spec, in the order they cost: an exact entry
 * hides the path and its whole subtree (prefix containment, no
 * globbing); a component pattern (no `/`) hides any path carrying a
 * matching name segment, which covers the subtree below a matching
 * directory for free; an anchored pattern (contains `/`) is tested
 * against the path and each of its ancestors, so a directory the
 * pattern hides keeps its descendants hidden too. Patterns match with
 * the repo fnmatch dialect, `*` crossing slashes as GNU `find -path`
 * does.
 */
export function pathHidden(hidden: HiddenPaths | null | undefined, virtual: string): boolean {
  if (hidden == null) return false
  const paths = hidden.paths ?? []
  const patterns = hidden.patterns ?? []
  if (paths.length === 0 && patterns.length === 0) return false
  const norm = normAbs(virtual)
  for (const entry of paths) {
    const p = normAbs(entry)
    if (norm === p || norm.startsWith(p + '/') || p === '/') return true
  }
  if (patterns.length === 0) return false
  const componentPats = patterns.filter((p) => !p.includes('/'))
  const anchoredPats = patterns.filter((p) => p.includes('/')).map(normAbs)
  const parts = norm.split('/').filter((seg) => seg !== '')
  if (componentPats.length > 0) {
    for (const seg of parts) {
      for (const pat of componentPats) {
        if (fnmatch(seg, pat)) return true
      }
    }
  }
  if (anchoredPats.length > 0) {
    let prefix = ''
    for (const seg of parts) {
      prefix = `${prefix}/${seg}`
      for (const pat of anchoredPats) {
        if (fnmatch(prefix, pat)) return true
      }
    }
  }
  return false
}

/** Whether the session's spec hides this variable name. */
export function varHidden(hidden: HiddenVars | null | undefined, name: string): boolean {
  if (hidden == null) return false
  if ((hidden.names ?? []).includes(name)) return true
  for (const pat of hidden.patterns ?? []) {
    if (fnmatch(name, pat)) return true
  }
  return false
}
