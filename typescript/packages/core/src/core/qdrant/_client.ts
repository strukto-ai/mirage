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

export type QdrantRow = Record<string, unknown>

export interface QdrantPoint {
  id: string | number
  payload?: Record<string, unknown> | null
  score?: number
}

export const SCROLL_BATCH = 256

export function coerce(value: string): string | number {
  if (/^-?\d+$/.test(value)) {
    const n = Number.parseInt(value, 10)
    if (String(n) === value) return n
  }
  return value
}

export function buildFilter(filters: Record<string, string>): Record<string, unknown> | undefined {
  const keys = Object.keys(filters)
  if (keys.length === 0) return undefined
  return {
    must: keys.map((key) => ({ key, match: { value: coerce(filters[key] ?? '') } })),
  }
}

export function pointToRow(point: QdrantPoint, idField: string): QdrantRow {
  const payload = point.payload ?? {}
  const row: QdrantRow = { ...payload }
  row[idField] = point.id
  return row
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function candidateIds(rowId: string): (string | number)[] {
  if (/^-?\d+$/.test(rowId)) return [Number.parseInt(rowId, 10)]
  if (UUID_RE.test(rowId)) return [rowId]
  return []
}
