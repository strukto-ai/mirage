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

import type { LanceRow } from './_driver.ts'
import type { LanceDBConfigResolved } from '../../vfs/lancedb/config.ts'

const ENC = new TextEncoder()
const SKIP_KEYS = new Set(['_distance', '_rowid', '_score'])

function toStr(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value as string | number | boolean | bigint)
}

export function renderCard(row: LanceRow, config: LanceDBConfigResolved): Uint8Array {
  const lines: string[] = []
  const title = config.titleColumn !== null ? row[config.titleColumn] : undefined
  if (title !== undefined && title !== null) {
    lines.push(`# ${toStr(title)}`)
    lines.push('')
  }
  for (const [key, value] of Object.entries(row)) {
    if (SKIP_KEYS.has(key)) continue
    if (key === config.vectorColumn || key === config.blobColumn) continue
    lines.push(`${key}: ${toStr(value)}`)
  }
  if (config.blobColumn !== null && config.idColumn in row) {
    lines.push(`blob: ${toStr(row[config.idColumn])}.${config.blobExt}`)
  }
  const distance = row._distance
  if (distance !== undefined && distance !== null) {
    lines.push(`score: ${Number(distance).toFixed(4)}`)
  }
  return ENC.encode(lines.join('\n') + '\n')
}
