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

import type { LanceRow } from './types.ts'
import type { LanceDBConfigResolved } from '../../vfs/lancedb/config.ts'
import { valueText } from '../render/json.ts'

const ENC = new TextEncoder()
const SKIP_KEYS = new Set(['_distance', '_rowid', '_score'])

function isJson(value: unknown): boolean {
  if (value === null) return true
  if (['string', 'boolean', 'number', 'bigint'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJson)
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value as Record<string, unknown>).every(isJson)
  }
  return false
}

/**
 * One column value as the card and the tree spell it.
 *
 * A JSON value spells as `valueText` does, so both hosts print one card
 * (`true`, `null`, `1.5`); a value JSON cannot hold, such as an Arrow
 * timestamp or bytes, falls back to `String`.
 */
export function cellText(value: unknown): string {
  return isJson(value) ? valueText(value) : String(value)
}

export function renderCard(row: LanceRow, config: LanceDBConfigResolved): Uint8Array {
  const lines: string[] = []
  const title = config.titleColumn !== null ? row[config.titleColumn] : undefined
  if (title !== undefined && title !== null) {
    lines.push(`# ${cellText(title)}`)
    lines.push('')
  }
  for (const [key, value] of Object.entries(row)) {
    if (SKIP_KEYS.has(key)) continue
    if (key === config.vectorColumn || key === config.blobColumn) continue
    lines.push(`${key}: ${cellText(value)}`)
  }
  if (config.blobColumn !== null && config.idColumn in row) {
    lines.push(`blob: ${cellText(row[config.idColumn])}.${config.blobExt}`)
  }
  return ENC.encode(lines.join('\n') + '\n')
}
