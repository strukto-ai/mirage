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

function iso(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${String(year)}-${mm}-${dd}T00:00:00Z`
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
}

function parseFixedInt(s: string | undefined, expectedLength: number): number | null {
  if (s?.length !== expectedLength || !/^\d+$/.test(s)) return null
  return Number.parseInt(s, 10)
}

export function globToModifiedRange(pattern: string | null | undefined): [string, string] | null {
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
    return [iso(year, 1, 1), iso(year + 1, 1, 1)]
  }
  if (parts.length === 2) {
    const year = parseFixedInt(parts[0], 4)
    const month = parseFixedInt(parts[1], 2)
    if (year === null || month === null) return null
    if (!isValidDate(year, month, 1)) return null
    if (month === 12) return [iso(year, month, 1), iso(year + 1, 1, 1)]
    return [iso(year, month, 1), iso(year, month + 1, 1)]
  }
  if (parts.length === 3) {
    const year = parseFixedInt(parts[0], 4)
    const month = parseFixedInt(parts[1], 2)
    const day = parseFixedInt(parts[2], 2)
    if (year === null || month === null || day === null) return null
    if (!isValidDate(year, month, day)) return null
    const start = new Date(Date.UTC(year, month - 1, day))
    const next = new Date(start.getTime() + 86400000)
    return [
      iso(year, month, day),
      iso(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
    ]
  }
  return null
}
