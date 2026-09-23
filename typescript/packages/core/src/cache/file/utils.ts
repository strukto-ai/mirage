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

/**
 * A cache token with every falsy spelling folded to "absent".
 *
 * `undefined` (none supplied), `null` (explicitly none) and `''` all mean
 * the bytes carry no backend token. Folding them in one place is what lets
 * the redis store spell "no token" as `''` on the wire without `''` ever
 * meaning something different from `null` in the RAM store. Python writes
 * this inline as `fingerprint or None`; `??` cannot express it, because it
 * would keep `''`.
 */
export function tokenOrNull(fingerprint?: string | null): string | null {
  if (fingerprint === undefined || fingerprint === null || fingerprint === '') return null
  return fingerprint
}

export function parseLimit(limit: string | number): number {
  if (typeof limit === 'number') return limit
  const s = limit.trim().toUpperCase()
  const suffixes: [string, number][] = [
    ['GB', 1 << 30],
    ['MB', 1 << 20],
    ['KB', 1 << 10],
  ]
  for (const [suffix, mult] of suffixes) {
    if (s.endsWith(suffix)) return parseInt(s.slice(0, -suffix.length), 10) * mult
  }
  return parseInt(s, 10)
}

/**
 * Escape a literal for use inside a redis MATCH pattern.
 *
 * Cache keys are mount paths, and a path may legitimately contain the glob
 * metacharacters redis SCAN interprets, so a prefix like `/data[1]/` would
 * otherwise match nothing (or the wrong keys).
 */
export function globEscape(literal: string): string {
  let out = ''
  for (const ch of literal) {
    if (ch === '*' || ch === '?' || ch === '[' || ch === ']' || ch === '\\') out += '\\'
    out += ch
  }
  return out
}
