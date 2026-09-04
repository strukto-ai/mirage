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

import type { QdrantConfigResolved } from '../../resource/qdrant/config.ts'
import { fitIdName, parseIdName } from '../../utils/naming.ts'
import { byteLength, pathSafeName } from '../../utils/sanitize.ts'
import type { QdrantRow } from './client.ts'

/** Read a Qdrant payload field, including `metadata.source`-style nested keys. */
export function fieldValue(row: QdrantRow, field: string | null): unknown {
  if (field === null || field === '') return undefined
  if (!field.includes('.')) return row[field]
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
  const copied: QdrantRow = {}
  for (const [key, value] of Object.entries(row)) {
    if (key !== head) {
      copied[key] = value
    } else if (tail.length > 0) {
      copied[key] =
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? omitPath(value as QdrantRow, tail)
          : value
    }
  }
  return copied
}

/** Render one payload value as a VFS segment, optionally using its URL/path basename. */
export function groupName(value: unknown, basename = false): string {
  let name = String(value as string | number | boolean | bigint)
  if (basename) {
    const withoutFragment = name.split('#', 1)[0] ?? name
    const withoutQuery = withoutFragment.split('?', 1)[0] ?? withoutFragment
    const trimmed = withoutQuery.replace(/[\\/]+$/, '')
    const parts = trimmed.replace(/\\/g, '/').split('/')
    const leaf = parts[parts.length - 1] ?? ''
    if (leaf !== '') name = leaf
  }
  return pathSafeName(name)
}

/** Undo the only transform applied by {@link groupName}. */
export function groupValue(name: string): string {
  return name.replace(/∕/g, '/')
}

/** Return the stable, human-readable stem for a point's files. */
export function rowStem(row: QdrantRow, config: QdrantConfigResolved): string {
  // The point id is synthetic rather than payload data: pointToRow stores it
  // under the configured key verbatim, even when that key contains dots.
  const pointId = String(row[config.idField] as string | number | bigint | boolean)
  const label = fieldValue(row, config.nameField)
  if (label === undefined || label === null) return pointId
  const suffixes = ['.json']
  if (config.textField !== null && config.textField !== '') suffixes.push('.txt')
  if (config.blobField !== null && config.blobField !== '') suffixes.push(`.${config.blobExt}`)
  const longestSuffix = suffixes.reduce((a, b) => (byteLength(a) >= byteLength(b) ? a : b))
  const fitted = fitIdName(
    pathSafeName(String(label as string | number | boolean | bigint)),
    pointId,
    longestSuffix,
  )
  return fitted.slice(0, -longestSuffix.length)
}

/** Recover the opaque Qdrant point id from a VFS file stem. */
export function pointIdFromStem(stem: string, config: QdrantConfigResolved): string {
  if (config.nameField === null || config.nameField === '') return stem
  try {
    return parseIdName(stem)[1]
  } catch {
    // A point missing the optional naming payload still lists by id.
    return stem
  }
}
