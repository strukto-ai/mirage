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

import type { QdrantAccessor } from '../../accessor/qdrant.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { valueText } from '../render/json.ts'
import { groupName, rowStem } from './naming.ts'
import { fieldValue } from './payload.ts'

import type { PointTest, QdrantPoint, QdrantRow } from './types.ts'

export const SCROLL_BATCH = 256

/**
 * The non-string JSON scalar a rendered group segment also spells, or null.
 *
 * A group value renders through `valueText`, so a boolean or a number lists
 * as its compact JSON and the segment alone cannot say which type the
 * payload holds. Only a spelling `valueText` would produce counts: `007`,
 * `-0` and `1.50` are strings and nothing else.
 */
export function jsonScalar(text: string): boolean | number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed === 'boolean') return parsed
  if (typeof parsed === 'number' && valueText(parsed) === text) return parsed
  return null
}

/**
 * What one rendered group segment matches in the payload: the string itself
 * always, and when the segment also spells a JSON scalar, that typed value
 * too, so descending into the `true` or `1.5` directory the listing
 * advertised finds the boolean or float points behind it. A number matches
 * as a closed range, which Qdrant applies to integer and float payloads
 * alike where `match` does not.
 */
export function condition(key: string, text: string): Record<string, unknown> {
  const asText = { key, match: { value: text } }
  const scalar = jsonScalar(text)
  if (scalar === null) return asText
  const typed =
    typeof scalar === 'boolean'
      ? { key, match: { value: scalar } }
      : { key, range: { gte: scalar, lte: scalar } }
  return { should: [asText, typed] }
}

export function buildFilter(filters: Record<string, string>): Record<string, unknown> | undefined {
  const keys = Object.keys(filters)
  if (keys.length === 0) return undefined
  return { must: keys.map((key) => condition(key, filters[key] ?? '')) }
}

/** Keep points whose id starts with a literal name prefix. */
export function idPrefixTest(prefix: string): PointTest {
  return (point) => String(point.id).startsWith(prefix)
}

/** Keep points whose payload value starts with a literal prefix. */
export function valuePrefixTest(column: string, prefix: string, basename = false): PointTest {
  return (point) => {
    const value = fieldValue(point.payload ?? {}, column)
    if (value === null || value === undefined) return false
    return groupName(value, basename).startsWith(prefix)
  }
}

/** Keep the first point of every raw value that renders as one group name. */
export function exactNameTest(
  column: string,
  name: string,
  basename: boolean,
  seen: Set<string>,
): PointTest {
  return (point) => {
    const value = fieldValue(point.payload ?? {}, column)
    if (value === null || value === undefined) return false
    const raw = valueText(value)
    if (seen.has(raw) || groupName(raw, basename) !== name) return false
    seen.add(raw)
    return true
  }
}

export function pointToRow(point: QdrantPoint, idField: string): QdrantRow {
  return { ...point.payload, [idField]: point.id }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function candidateIds(rowId: string): (string | number)[] {
  if (/^-?\d+$/.test(rowId)) return [Number.parseInt(rowId, 10)]
  if (UUID_RE.test(rowId)) return [rowId]
  return []
}

interface ScrollPage {
  points: QdrantPoint[]
  next_page_offset?: string | number | null
}

async function scrollRaw(
  accessor: QdrantAccessor,
  collection: string,
  filter: Record<string, unknown> | undefined,
  limit: number,
  keep?: PointTest,
): Promise<QdrantPoint[]> {
  // Without a test the limit bounds the scroll, which is the ordinary capped
  // listing. With one it bounds the MATCHES, because qdrant has no prefix
  // condition for a point id or a keyword field: the only way to answer a
  // glob for a row past the cap is to keep scrolling and test each page
  // here. A glob is a targeted request, so it pays a scan of the collection
  // where the plain listing pays one page.
  const client = await accessor.client()
  const points: QdrantPoint[] = []
  let offset: string | number | null = null
  while (points.length < limit) {
    const res = (await client.scroll(collection, {
      ...(filter !== undefined ? { filter } : {}),
      limit: keep !== undefined ? SCROLL_BATCH : Math.min(SCROLL_BATCH, limit - points.length),
      offset,
      with_payload: true,
      with_vector: false,
    })) as ScrollPage
    points.push(...(keep === undefined ? res.points : res.points.filter(keep)))
    const next = res.next_page_offset
    if (next === null || next === undefined) break
    offset = next
  }
  return points.slice(0, limit)
}

function isIndexRequired(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { status?: number; data?: unknown; message?: string }
  if (e.status !== 400) return false
  const text = `${JSON.stringify(e.data ?? '')} ${e.message ?? ''}`.toLowerCase()
  return text.includes('index required')
}

async function ensureIndexes(accessor: QdrantAccessor, collection: string): Promise<void> {
  if (accessor.indexesEnsured.has(collection)) return
  const client = await accessor.client()
  for (const field of accessor.config.groupBy) {
    await (
      client as unknown as { createPayloadIndex: (c: string, o: object) => Promise<void> }
    ).createPayloadIndex(collection, { field_name: field, field_schema: 'keyword' })
  }
  accessor.indexesEnsured.add(collection)
}

async function scrollAll(
  accessor: QdrantAccessor,
  collection: string,
  filters: Record<string, string>,
  limit: number,
  keep?: PointTest,
): Promise<QdrantPoint[]> {
  const filter = buildFilter(filters)
  if (filter === undefined) return scrollRaw(accessor, collection, undefined, limit, keep)
  try {
    return await scrollRaw(accessor, collection, filter, limit, keep)
  } catch (err) {
    if (!isIndexRequired(err)) throw err
  }
  await ensureIndexes(accessor, collection)
  return scrollRaw(accessor, collection, filter, limit, keep)
}

export async function listTables(accessor: QdrantAccessor): Promise<string[]> {
  const client = await accessor.client()
  const res = (await client.getCollections()) as { collections: { name: string }[] }
  return res.collections.map((c) => c.name).sort(compareCodePoints)
}

export async function tableExists(accessor: QdrantAccessor, name: string): Promise<boolean> {
  const client = await accessor.client()
  const res = (await client.collectionExists(name)) as { exists: boolean }
  return res.exists
}

export async function distinctValues(
  accessor: QdrantAccessor,
  table: string,
  column: string,
  filters: Record<string, string>,
  limit: number,
  prefix = '',
  basename = false,
): Promise<string[]> {
  const keep = prefix === '' ? undefined : valuePrefixTest(column, prefix, basename)
  const points = await scrollAll(accessor, table, filters, limit, keep)
  const values = new Set<string>()
  for (const point of points) {
    const value = fieldValue(point.payload ?? {}, column)
    if (value !== null && value !== undefined) values.add(valueText(value))
  }
  return [...values].sort(compareCodePoints)
}

/**
 * The raw payload values one rendered group segment stands for.
 *
 * A basename drops the value's parents, so two sources can render as the
 * same directory. Telling them apart is a question about every point under
 * the parent group, not about the first `maxRows`: the scroll runs until it
 * is exhausted or a second distinct value has rendered as `name`, whichever
 * comes first. One value is the answer; two is a collision for the caller
 * to refuse.
 */
export async function resolveGroup(
  accessor: QdrantAccessor,
  table: string,
  column: string,
  filters: Record<string, string>,
  name: string,
  basename = false,
): Promise<string[]> {
  const keep = exactNameTest(column, name, basename, new Set<string>())
  const points = await scrollAll(accessor, table, filters, 2, keep)
  return points
    .map((point) => valueText(fieldValue(point.payload ?? {}, column)))
    .sort(compareCodePoints)
}

export async function rowsMatching(
  accessor: QdrantAccessor,
  table: string,
  filters: Record<string, string>,
  limit: number,
  prefix = '',
): Promise<QdrantRow[]> {
  const config = accessor.config
  const keep =
    prefix === ''
      ? undefined
      : config.nameField !== null
        ? (point: QdrantPoint) =>
            rowStem(pointToRow(point, config.idField), config).startsWith(prefix)
        : idPrefixTest(prefix)
  const points = await scrollAll(accessor, table, filters, limit, keep)
  return points.map((point) => pointToRow(point, config.idField))
}

export async function rowRecord(
  accessor: QdrantAccessor,
  table: string,
  idField: string,
  rowId: string,
): Promise<QdrantRow | null> {
  const ids = candidateIds(rowId)
  if (ids.length === 0) return null
  const client = await accessor.client()
  const found = (await client.retrieve(table, {
    ids,
    with_payload: true,
    with_vector: false,
  })) as QdrantPoint[]
  return found[0] !== undefined ? pointToRow(found[0], idField) : null
}

export async function searchRows(
  accessor: QdrantAccessor,
  table: string,
  query: string,
  limit: number,
): Promise<QdrantRow[]> {
  const key = JSON.stringify([table, query, limit])
  const hit = accessor.searchCache.get(key)
  if (hit !== undefined) return hit
  const config = accessor.config
  const client = await accessor.client()
  // A caller-supplied `embed` vectorizes the query here, and cloud inference
  // sends the text to a cluster that embeds it. Python embeds in process when
  // neither is set, which no JS client can.
  let vector: number[] | { text: string; model: string }
  if (config.embed !== null) vector = await config.embed(query)
  else if (config.cloudInference) vector = { text: query, model: config.embeddingModel }
  else {
    throw new Error(
      'search: the query needs a vector: pass embed, or set cloud_inference for a cluster with inference',
    )
  }
  const res = (await client.query(table, {
    query: vector,
    limit,
    with_payload: true,
  })) as { points: QdrantPoint[] }
  const rows = res.points.map((point) => {
    const row = pointToRow(point, config.idField)
    row._score = point.score
    return row
  })
  accessor.searchCache.set(key, rows)
  return rows
}
