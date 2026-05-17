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

import type { EntityKind } from './types.ts'

export interface MongoFindOptions {
  limit?: number
  sort?: Record<string, 1 | -1>
  projection?: Record<string, unknown>
  skip?: number
}

export interface MongoIterOptions {
  filter?: Record<string, unknown>
  sort?: Record<string, 1 | -1>
  projection?: Record<string, unknown>
  batchSize?: number
}

export interface MongoCollectionSpec {
  name: string
  type?: string
  options?: { validator?: { $jsonSchema?: unknown } | Record<string, unknown> }
}

export interface MongoIndexAccess {
  ops?: number
  since?: string
}

export interface MongoDriver {
  listDatabases(): Promise<string[]>
  listCollections(database: string, kind?: EntityKind | null): Promise<string[]>
  listCollectionsDetailed(
    database: string,
    filter?: { name?: string },
  ): Promise<MongoCollectionSpec[]>
  findDocuments<T = Record<string, unknown>>(
    database: string,
    collection: string,
    filter?: Record<string, unknown>,
    options?: MongoFindOptions,
  ): Promise<T[]>
  iterDocuments<T = Record<string, unknown>>(
    database: string,
    collection: string,
    options?: MongoIterOptions,
  ): AsyncIterableIterator<T>
  iterInserts<T = Record<string, unknown>>(
    database: string,
    collection: string,
  ): AsyncIterableIterator<T>
  countDocuments(
    database: string,
    collection: string,
    filter?: Record<string, unknown>,
  ): Promise<number>
  listIndexes(database: string, collection: string): Promise<Record<string, unknown>[]>
  getIndexStats(database: string, collection: string): Promise<Record<string, MongoIndexAccess>>
  close(): Promise<void>
}
