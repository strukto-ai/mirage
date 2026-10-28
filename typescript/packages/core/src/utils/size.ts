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

const SIZE = /^[ \t\n\r\f\v]*([0-9]+)(?:([KMG])B?)?[ \t\n\r\f\v]*$/i
const UNITS: Record<string, number> = { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30 }

/**
 * A size in bytes: a number, digits, or digits with a binary suffix,
 * `KB`/`MB`/`GB` or sandlock's `K`/`M`/`G`, in any case. `field` names the
 * setting a refusal starts with.
 *
 * The grammar is Python's `parse_limit` exactly: ASCII digits, no sign,
 * separator, fraction or inner space, at most 2**53 - 1 bytes.
 *
 * Throws:
 *   Error: the value is not a size.
 */
export function parseLimit(limit: string | number, field: string): number {
  let size: number | null = null
  if (typeof limit === 'number') {
    size = limit
  } else if (typeof limit === 'string') {
    const match = SIZE.exec(limit)
    if (match !== null) {
      const unit = match[2]
      size = Number(match[1]) * (unit === undefined ? 1 : (UNITS[unit.toUpperCase()] ?? 1))
    }
  }
  if (size === null || !Number.isSafeInteger(size) || size < 0) {
    const shown =
      typeof limit === 'number' && !Number.isFinite(limit) ? String(limit) : JSON.stringify(limit)
    throw new Error(`${field} must be a size like 100MB, got ${shown}`)
  }
  return size
}
