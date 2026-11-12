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

import type { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { BsonTypeTag, PRIMARY_KEY } from './types.ts'
import { isPlainObject } from '../../utils/records.ts'
import { compareCodePoints } from '../../utils/sort.ts'

function bump(counts: Map<string, Map<string, number>>, path: string, tag: string): void {
  let inner = counts.get(path)
  if (inner === undefined) {
    inner = new Map()
    counts.set(path, inner)
  }
  inner.set(tag, (inner.get(tag) ?? 0) + 1)
}

function scalarTag(v: unknown): string {
  if (typeof v === 'boolean') return BsonTypeTag.BOOL
  if (typeof v === 'number') return Number.isInteger(v) ? BsonTypeTag.INT : BsonTypeTag.DOUBLE
  if (typeof v === 'string') return BsonTypeTag.STRING
  if (v === null) return BsonTypeTag.NULL
  if (v instanceof Date) return BsonTypeTag.DATE
  if (v instanceof RegExp) return BsonTypeTag.REGEX
  switch (typeof v === 'object' ? (v as { _bsontype?: string })._bsontype : undefined) {
    case 'Long':
      return BsonTypeTag.LONG
    case 'ObjectId':
    case 'ObjectID':
      return BsonTypeTag.OBJECT_ID
    case 'Decimal128':
      return BsonTypeTag.DECIMAL
    case 'Timestamp':
      return BsonTypeTag.TIMESTAMP
    case 'Binary':
      return BsonTypeTag.BINARY
    case 'BSONRegExp':
      return BsonTypeTag.REGEX
    case 'DBRef':
      return BsonTypeTag.OBJECT
    default:
      return BsonTypeTag.UNKNOWN
  }
}

function arrayTag(items: readonly unknown[]): string {
  if (items.length === 0) return BsonTypeTag.ARRAY
  if (items.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    return `array<${BsonTypeTag.DOUBLE}>(${String(items.length)})`
  }
  if (items.every((x) => typeof x === 'string')) {
    return `array<${BsonTypeTag.STRING}>`
  }
  return BsonTypeTag.ARRAY
}

function walk(value: unknown, prefix: string, counts: Map<string, Map<string, number>>): void {
  if (isPlainObject(value)) {
    if (prefix !== '') bump(counts, prefix, BsonTypeTag.OBJECT)
    for (const [k, v] of Object.entries(value)) {
      const next = prefix === '' ? k : `${prefix}.${k}`
      walk(v, next, counts)
    }
    return
  }
  if (Array.isArray(value)) {
    if (prefix !== '') bump(counts, prefix, arrayTag(value))
    return
  }
  if (prefix !== '') bump(counts, prefix, scalarTag(value))
}

export async function sampleFieldTypes(
  accessor: MongoDBAccessor,
  database: string,
  collection: string,
  sampleSize = 100,
) {
  const counts = new Map<string, Map<string, number>>()
  let total = 0
  for await (const doc of accessor.driver.iterDocuments(database, collection, {
    batchSize: sampleSize,
    sort: { _id: 1 },
  })) {
    total++
    walk(doc, '', counts)
    if (total >= sampleSize) break
  }
  if (total === 0) return []
  const fields: { path: string; presence: number; types: Record<string, number> }[] = []
  for (const path of [...counts.keys()].sort(compareCodePoints)) {
    if (path === PRIMARY_KEY) continue
    const inner = counts.get(path) ?? new Map<string, number>()
    const presenceCount = [...inner.values()].reduce((a, b) => a + b, 0)
    const types: Record<string, number> = {}
    for (const [t, c] of inner) types[t] = c / total
    fields.push({
      path,
      presence: presenceCount / total,
      types,
    })
  }
  return fields
}
