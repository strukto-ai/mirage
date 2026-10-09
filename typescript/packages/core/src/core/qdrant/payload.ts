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

import type { QdrantRow } from './types.ts'

/** Read a Qdrant payload field, including `metadata.source`-style nested keys. */
export function fieldValue(row: QdrantRow, field: string | null): unknown {
  if (field === null || field === '') return undefined
  let value: unknown = row
  for (const part of field.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (!Object.hasOwn(record, part)) return undefined
    value = record[part]
  }
  return value
}

/** Copy a payload while removing one dotted field path. */
export function withoutField(row: QdrantRow, field: string | null): QdrantRow {
  if (field === null || field === '') return { ...row }
  return omitPath(row, field.split('.'))
}

function omitPath(row: QdrantRow, parts: string[]): QdrantRow {
  const [head, ...tail] = parts
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => key !== head || tail.length > 0)
      .map(([key, value]) => [
        key,
        key === head && typeof value === 'object' && value !== null && !Array.isArray(value)
          ? omitPath(value as QdrantRow, tail)
          : value,
      ]),
  )
}
