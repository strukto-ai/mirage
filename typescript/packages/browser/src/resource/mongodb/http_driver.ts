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

import type {
  EntityKind,
  MongoCollectionSpec,
  MongoDriver,
  MongoFindOptions,
  MongoIndexAccess,
  MongoIterOptions,
} from '@struktoai/mirage-core'

export interface HttpMongoDriverOptions {
  endpoint: string
  fetchImpl?: typeof fetch
  headers?: Record<string, string>
}

interface MongoProxyRequest {
  op:
    | 'listDatabases'
    | 'listCollections'
    | 'listCollectionsDetailed'
    | 'findDocuments'
    | 'iterDocuments'
    | 'countDocuments'
    | 'listIndexes'
    | 'getIndexStats'
  database?: string
  collection?: string
  kind?: EntityKind | null
  nameFilter?: { name?: string }
  filter?: Record<string, unknown>
  options?: MongoFindOptions | MongoIterOptions
}

export class HttpMongoDriver implements MongoDriver {
  readonly endpoint: string
  private readonly fetchImpl: typeof fetch
  private readonly headers: Record<string, string>

  constructor(options: HttpMongoDriverOptions) {
    this.endpoint = options.endpoint
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
    this.headers = options.headers ?? {}
  }

  private async post<T>(req: MongoProxyRequest): Promise<T> {
    const r = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(req),
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`mongo proxy ${req.op} → ${String(r.status)} ${body}`)
    }
    return (await r.json()) as T
  }

  listDatabases(): Promise<string[]> {
    return this.post<string[]>({ op: 'listDatabases' })
  }

  listCollections(database: string, kind: EntityKind | null = null): Promise<string[]> {
    return this.post<string[]>({ op: 'listCollections', database, kind })
  }

  listCollectionsDetailed(
    database: string,
    filter: { name?: string } = {},
  ): Promise<MongoCollectionSpec[]> {
    return this.post<MongoCollectionSpec[]>({
      op: 'listCollectionsDetailed',
      database,
      nameFilter: filter,
    })
  }

  async findDocuments<T = Record<string, unknown>>(
    database: string,
    collection: string,
    filter: Record<string, unknown> = {},
    options: MongoFindOptions = {},
  ): Promise<T[]> {
    return this.post<T[]>({
      op: 'findDocuments',
      database,
      collection,
      filter,
      options,
    })
  }

  async *iterDocuments<T = Record<string, unknown>>(
    database: string,
    collection: string,
    options: MongoIterOptions = {},
  ): AsyncIterableIterator<T> {
    const docs = await this.post<T[]>({
      op: 'iterDocuments',
      database,
      collection,
      options,
    })
    for (const d of docs) yield d
  }

  iterInserts<T = Record<string, unknown>>(
    _database: string,
    _collection: string,
  ): AsyncIterableIterator<T> {
    return {
      next: () =>
        Promise.reject(new Error('iterInserts (tail -f) is not supported by HttpMongoDriver')),
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }

  countDocuments(
    database: string,
    collection: string,
    filter: Record<string, unknown> = {},
  ): Promise<number> {
    return this.post<number>({ op: 'countDocuments', database, collection, filter })
  }

  listIndexes(database: string, collection: string): Promise<Record<string, unknown>[]> {
    return this.post<Record<string, unknown>[]>({
      op: 'listIndexes',
      database,
      collection,
    })
  }

  getIndexStats(database: string, collection: string): Promise<Record<string, MongoIndexAccess>> {
    return this.post<Record<string, MongoIndexAccess>>({
      op: 'getIndexStats',
      database,
      collection,
    })
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}
