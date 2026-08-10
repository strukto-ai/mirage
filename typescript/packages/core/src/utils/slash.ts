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

export function rstripSlash(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--
  return s.slice(0, end)
}

export function lstripSlash(s: string): string {
  let start = 0
  while (start < s.length && s.charCodeAt(start) === 47) start++
  return s.slice(start)
}

export function stripSlash(s: string): string {
  let start = 0
  let end = s.length
  while (start < end && s.charCodeAt(start) === 47) start++
  while (end > start && s.charCodeAt(end - 1) === 47) end--
  return s.slice(start, end)
}

// The trailing-slash directory form prefix comparisons need, so '/a/'
// cannot match '/ab' ('foo/bar' -> '/foo/bar/', '' -> '/').
export function normDir(s: string): string {
  const stripped = stripSlash(s)
  return stripped === '' ? '/' : '/' + stripped + '/'
}

/**
 * The longest mount prefix owning `path`, or null.
 *
 * The one longest-prefix rule dispatch resolves a path by, shared so a
 * registry, a runtime routing table and a link filter cannot drift: a
 * prefix owns its own root (with or without a trailing slash) and
 * everything at a path boundary below it, so '/a/' owns '/a' and '/a/b'
 * but never '/ab'. The winner is returned in its input spelling,
 * letting each caller keep its own convention.
 */
export function ownerPrefix(prefixes: Iterable<string>, path: string): string | null {
  const target = normDir(path)
  let best: string | null = null
  let bestLen = -1
  for (const prefix of prefixes) {
    const p = normDir(prefix)
    if (target.startsWith(p) && p.length > bestLen) {
      best = prefix
      bestLen = p.length
    }
  }
  return best
}
