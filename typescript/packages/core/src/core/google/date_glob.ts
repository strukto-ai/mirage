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

import { GLOB_CHARS } from '../../utils/glob_walk.ts'

function day(year: number, month: number, date: number): string {
  const mm = String(month).padStart(2, '0')
  const dd = String(date).padStart(2, '0')
  return `${String(year)}-${mm}-${dd}`
}

function isValidDate(year: number, month: number, date: number): boolean {
  if (month < 1 || month > 12 || date < 1) return false
  const d = new Date(Date.UTC(year, month - 1, date))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === date
}

function parseFixedInt(s: string | undefined, expectedLength: number): number | null {
  if (s?.length !== expectedLength || !/^\d+$/.test(s)) return null
  return Number.parseInt(s, 10)
}

/**
 * Translate a date-prefixed glob into a half-open range of floating dates.
 *
 * Kept separate from `globToModifiedRange` because a caller bucketing in a
 * named time zone has to build its own bounds from the dates; UTC instants
 * would silently shift the window by the zone's offset.
 */
export function globToDateRange(pattern: string | null | undefined): [string, string] | null {
  if (!pattern) return null
  let metaIndex = -1
  for (const ch of GLOB_CHARS) {
    const idx = pattern.indexOf(ch)
    if (idx !== -1 && (metaIndex === -1 || idx < metaIndex)) metaIndex = idx
  }
  if (metaIndex === -1) return null
  const prefix = pattern.slice(0, metaIndex).replace(/[_-]+$/, '')
  const parts = prefix.split('-')
  if (parts.length === 1) {
    const year = parseFixedInt(parts[0], 4)
    if (year === null) return null
    return [day(year, 1, 1), day(year + 1, 1, 1)]
  }
  if (parts.length === 2) {
    const year = parseFixedInt(parts[0], 4)
    const month = parseFixedInt(parts[1], 2)
    if (year === null || month === null) return null
    if (!isValidDate(year, month, 1)) return null
    if (month === 12) return [day(year, month, 1), day(year + 1, 1, 1)]
    return [day(year, month, 1), day(year, month + 1, 1)]
  }
  if (parts.length === 3) {
    const year = parseFixedInt(parts[0], 4)
    const month = parseFixedInt(parts[1], 2)
    const date = parseFixedInt(parts[2], 2)
    if (year === null || month === null || date === null) return null
    if (!isValidDate(year, month, date)) return null
    const next = new Date(Date.UTC(year, month - 1, date) + 86400000)
    return [
      day(year, month, date),
      day(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
    ]
  }
  return null
}

/** Translate a date-prefixed glob into an RFC3339 modifiedTime range. */
export function globToModifiedRange(pattern: string | null | undefined): [string, string] | null {
  const span = globToDateRange(pattern)
  if (span === null) return null
  return [`${span[0]}T00:00:00Z`, `${span[1]}T00:00:00Z`]
}
