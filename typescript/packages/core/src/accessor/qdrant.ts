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

import type { QdrantClient } from '@qdrant/js-client-rest'
import { Accessor } from './base.ts'
import { loadOptionalPeer } from '../utils/optional_peer.ts'
import {
  buildFilter,
  candidateIds,
  pointToRow,
  SCROLL_BATCH,
  type QdrantPoint,
  type QdrantRow,
} from '../core/qdrant/_client.ts'
import type { QdrantConfigResolved } from '../resource/qdrant/config.ts'

type QdrantClientCtor = new (opts: {
  url?: string
  host?: string
  port?: number
  https?: boolean
  apiKey?: string
}) => QdrantClient

export class QdrantAccessor extends Accessor {
  readonly config: QdrantConfigResolved
  private client: QdrantClient | null = null
  private readonly indexesEnsured = new Set<string>()
  private readonly searchCache = new Map<string, QdrantRow[]>()

  constructor(config: QdrantConfigResolved) {
    super()
    this.config = config
  }

  private async getClient(): Promise<QdrantClient> {
    if (this.client === null) {
      const mod = (await loadOptionalPeer(
        () => import(/* @vite-ignore */ '@qdrant/js-client-rest'),
        { feature: 'QdrantResource', packageName: '@qdrant/js-client-rest' },
      )) as { QdrantClient: QdrantClientCtor }
      const auth = this.config.apiKey !== null ? { apiKey: this.config.apiKey } : {}
      this.client = new mod.QdrantClient(
        this.config.url !== null
          ? { url: this.config.url, ...auth }
          : { host: this.config.host, port: this.config.port, https: this.config.https, ...auth },
      )
    }
    return this.client
  }

  private async scrollRaw(
    collection: string,
    filter: Record<string, unknown> | undefined,
    limit: number,
  ): Promise<QdrantPoint[]> {
    const client = await this.getClient()
    const points: QdrantPoint[] = []
    let offset: string | number | null = null
    while (points.length < limit) {
      const res = (await client.scroll(collection, {
        ...(filter !== undefined ? { filter } : {}),
        limit: Math.min(SCROLL_BATCH, limit - points.length),
        offset,
        with_payload: true,
        with_vector: false,
      })) as { points: QdrantPoint[]; next_page_offset?: string | number | null }
      points.push(...res.points)
      const next = res.next_page_offset
      if (next === null || next === undefined) break
      offset = next
    }
    return points.slice(0, limit)
  }

  private async ensureIndexes(collection: string): Promise<void> {
    if (this.indexesEnsured.has(collection)) return
    const client = await this.getClient()
    for (const field of this.config.groupBy) {
      await (
        client as unknown as { createPayloadIndex: (c: string, o: object) => Promise<void> }
      ).createPayloadIndex(collection, { field_name: field, field_schema: 'keyword' })
    }
    this.indexesEnsured.add(collection)
  }

  private isIndexRequired(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false
    const e = err as { status?: number; data?: unknown; message?: string }
    if (e.status !== 400) return false
    const text = `${JSON.stringify(e.data ?? '')} ${e.message ?? ''}`.toLowerCase()
    return text.includes('index required')
  }

  private async scrollFiltered(
    collection: string,
    filters: Record<string, string>,
    limit: number,
  ): Promise<QdrantPoint[]> {
    if (Object.keys(filters).length === 0) return this.scrollRaw(collection, undefined, limit)
    const filter = buildFilter(filters)
    try {
      return await this.scrollRaw(collection, filter, limit)
    } catch (err) {
      if (!this.isIndexRequired(err)) throw err
    }
    await this.ensureIndexes(collection)
    return this.scrollRaw(collection, filter, limit)
  }

  async listTables(): Promise<string[]> {
    const client = await this.getClient()
    const res = (await client.getCollections()) as { collections: { name: string }[] }
    return res.collections.map((c) => c.name).sort()
  }

  async tableExists(name: string): Promise<boolean> {
    const client = await this.getClient()
    const res = (await client.collectionExists(name)) as { exists: boolean }
    return res.exists
  }

  async distinct(
    table: string,
    column: string,
    filters: Record<string, string>,
    limit: number,
  ): Promise<string[]> {
    const points = await this.scrollFiltered(table, filters, limit)
    const values = new Set<string>()
    for (const point of points) {
      const value = point.payload?.[column]
      if (value !== null && value !== undefined)
        values.add(String(value as string | number | boolean))
    }
    return [...values].sort()
  }

  async rowsMatching(
    table: string,
    filters: Record<string, string>,
    _columns: string[],
    limit: number,
  ): Promise<QdrantRow[]> {
    const points = await this.scrollFiltered(table, filters, limit)
    return points.map((point) => pointToRow(point, this.config.idField))
  }

  async rowRecord(table: string, idField: string, rowId: string): Promise<QdrantRow | null> {
    const ids = candidateIds(rowId)
    if (ids.length === 0) return null
    const client = await this.getClient()
    const found = (await client.retrieve(table, {
      ids,
      with_payload: true,
      with_vector: false,
    })) as QdrantPoint[]
    return found[0] !== undefined ? pointToRow(found[0], idField) : null
  }

  async searchRows(table: string, query: string, limit: number): Promise<QdrantRow[]> {
    const key = JSON.stringify([table, query, limit])
    const hit = this.searchCache.get(key)
    if (hit !== undefined) return hit
    const client = await this.getClient()
    const res = (await client.query(table, {
      query: { text: query, model: this.config.embeddingModel },
      limit,
      with_payload: true,
    })) as { points: QdrantPoint[] }
    const rows = res.points.map((point) => {
      const row = pointToRow(point, this.config.idField)
      row._score = point.score
      return row
    })
    this.searchCache.set(key, rows)
    return rows
  }
}
