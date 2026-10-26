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
  MongoCollectionSpec,
  MongoDriver,
  MongoFindOptions,
  MongoIterOptions,
} from '@struktoai/mirage-core/core/mongodb/_driver'
import { EntityKind, NOT_A_REPLICA_SET } from '@struktoai/mirage-core/core/mongodb/types'
import { loadOptionalPeer } from '@struktoai/mirage-core/utils/optional_peer'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { VERSION } from '../../version.ts'

const DRIVER_INFO = { name: 'Mirage', version: VERSION }

interface MongoCollectionLike {
  find: (
    filter: Record<string, unknown>,
    options?: { projection?: Record<string, unknown> },
  ) => {
    sort: (sort: Record<string, 1 | -1>) => MongoCursorLike
    skip: (n: number) => MongoCursorLike
    limit: (n: number) => MongoCursorLike
    batchSize: (n: number) => MongoCursorLike
    toArray: () => Promise<Record<string, unknown>[]>
    [Symbol.asyncIterator]?: () => AsyncIterableIterator<Record<string, unknown>>
  }
  countDocuments: (filter?: Record<string, unknown>) => Promise<number>
  listIndexes: () => { toArray: () => Promise<Record<string, unknown>[]> }
  aggregate: (pipeline: unknown[]) => { toArray: () => Promise<Record<string, unknown>[]> }
  watch: (
    pipeline?: unknown[],
    options?: { startAtOperationTime?: unknown },
  ) => { next: () => Promise<Record<string, unknown>>; close: () => Promise<void> }
}

interface MongoCursorLike {
  sort: (sort: Record<string, 1 | -1>) => MongoCursorLike
  skip: (n: number) => MongoCursorLike
  limit: (n: number) => MongoCursorLike
  batchSize: (n: number) => MongoCursorLike
  toArray: () => Promise<Record<string, unknown>[]>
  [Symbol.asyncIterator]?: () => AsyncIterableIterator<Record<string, unknown>>
}

interface MongoDbLike {
  listCollections: (filter?: Record<string, unknown>) => {
    toArray: () => Promise<Record<string, unknown>[]>
  }
  collection: (name: string) => MongoCollectionLike
  command: (command: Record<string, unknown>) => Promise<Record<string, unknown>>
  admin: () => { listDatabases: () => Promise<{ databases: { name: string }[] }> }
}

interface SnapshotCursor<T> {
  id: unknown
  atClusterTime?: unknown
  firstBatch?: T[]
  nextBatch?: T[]
}

interface MongoClientLike {
  connect: () => Promise<MongoClientLike>
  db: (name?: string) => MongoDbLike
  close: () => Promise<void>
}

interface MongoModule {
  MongoClient: new (
    uri: string,
    options?: { driverInfo?: { name: string; version?: string } },
  ) => MongoClientLike
}

export class MongoDBStore implements MongoDriver {
  readonly uri: string
  private clientPromise: Promise<MongoClientLike> | null = null

  constructor(uri: string) {
    this.uri = uri
  }

  async listDatabases(): Promise<string[]> {
    const c = await this._client()
    const r = await c.db().admin().listDatabases()
    return r.databases.map((d) => d.name)
  }

  async listCollections(database: string, kind: EntityKind | null = null): Promise<string[]> {
    const c = await this._client()
    const filter =
      kind === null
        ? undefined
        : { type: kind === EntityKind.COLLECTION ? { $ne: EntityKind.VIEW } : kind }
    const cols = await c.db(database).listCollections(filter).toArray()
    return cols.map((col) => col.name as string).sort(compareCodePoints)
  }

  async listCollectionsDetailed(
    database: string,
    filter: { name?: string } = {},
  ): Promise<MongoCollectionSpec[]> {
    const c = await this._client()
    const cols = await c.db(database).listCollections(filter).toArray()
    return cols.map((col) => {
      const spec: MongoCollectionSpec = { name: col.name as string }
      if (col.type !== undefined) spec.type = col.type as string
      if (col.options !== undefined)
        spec.options = col.options as NonNullable<MongoCollectionSpec['options']>
      return spec
    })
  }

  async findDocuments<T = Record<string, unknown>>(
    database: string,
    collection: string,
    filter: Record<string, unknown> = {},
    options: MongoFindOptions = {},
  ): Promise<T[]> {
    const c = await this._client()
    let cursor = c
      .db(database)
      .collection(collection)
      .find(filter, {
        ...(options.projection !== undefined ? { projection: options.projection } : {}),
      }) as MongoCursorLike
    if (options.sort !== undefined) cursor = cursor.sort(options.sort)
    if (options.skip !== undefined) cursor = cursor.skip(options.skip)
    if (options.limit !== undefined) cursor = cursor.limit(options.limit)
    return (await cursor.toArray()) as T[]
  }

  async *iterDocuments<T = Record<string, unknown>>(
    database: string,
    collection: string,
    options: MongoIterOptions = {},
  ): AsyncIterableIterator<T> {
    const c = await this._client()
    const filter = options.filter ?? {}
    let cursor = c
      .db(database)
      .collection(collection)
      .find(filter, {
        ...(options.projection !== undefined ? { projection: options.projection } : {}),
      }) as MongoCursorLike
    if (options.sort !== undefined) cursor = cursor.sort(options.sort)
    if (options.batchSize !== undefined) cursor = cursor.batchSize(options.batchSize)
    if (cursor[Symbol.asyncIterator] === undefined) {
      const all = (await cursor.toArray()) as T[]
      for (const doc of all) yield doc
      return
    }
    for await (const doc of cursor as unknown as AsyncIterableIterator<T>) {
      yield doc
    }
  }

  async findSnapshot<T = Record<string, unknown>>(
    database: string,
    collection: string,
    options: MongoFindOptions,
  ): Promise<[T[], unknown] | null> {
    const db = (await this._client()).db(database)
    let reply: Record<string, unknown>
    try {
      reply = await db.command({
        find: collection,
        sort: options.sort ?? {},
        limit: options.limit ?? 0,
        batchSize: options.limit ?? 0,
        readConcern: { level: 'snapshot' },
      })
    } catch (err) {
      if ((err as { code?: unknown }).code !== NOT_A_REPLICA_SET) throw err
      console.debug(`no snapshot read on ${database}: ${String(err)}`)
      return null
    }
    let cursor = reply.cursor as SnapshotCursor<T>
    const at = cursor.atClusterTime
    const docs = [...(cursor.firstBatch ?? [])]
    // A cursor id past 2^53 arrives as a Long and goes back as one; a smaller
    // one arrives as a number, which goes back as an int64 only as a bigint.
    const wire = (id: unknown): unknown => (typeof id === 'number' ? BigInt(id) : id)
    try {
      while (String(cursor.id) !== '0') {
        const more = await db.command({ getMore: wire(cursor.id), collection })
        cursor = more.cursor as SnapshotCursor<T>
        for (const item of cursor.nextBatch ?? []) docs.push(item)
      }
    } finally {
      // A failed batch leaves the server cursor open.
      if (String(cursor.id) !== '0') {
        await db
          .command({ killCursors: collection, cursors: [wire(cursor.id)] })
          .catch((err: unknown) => {
            console.debug(`killCursors failed on ${collection}: ${String(err)}`)
          })
      }
    }
    return [docs, at]
  }

  /**
   * Each inserted document, from a change stream. An iterator rather than a
   * generator, so `return` closes the stream at once, ending a pull that waits
   * for the next insert, where a generator would queue behind that pull.
   */
  iterInserts<T = Record<string, unknown>>(
    database: string,
    collection: string,
    after: unknown = null,
  ): AsyncIterableIterator<T> {
    type Stream = ReturnType<MongoCollectionLike['watch']>
    let stream: Stream | null = null
    let closed = false
    // `return` can close the stream while a pull awaits it.
    const isClosed = (): boolean => closed
    const done: IteratorResult<T> = { value: undefined, done: true }
    const open = async (): Promise<Stream | null> => {
      const c = await this._client()
      const match: Record<string, unknown> = { operationType: 'insert' }
      if (after !== null) match.clusterTime = { $gt: after }
      const opened = c
        .db(database)
        .collection(collection)
        .watch([{ $match: match }], after === null ? {} : { startAtOperationTime: after })
      if (closed) {
        await opened.close()
        return null
      }
      stream = opened
      return opened
    }
    return {
      async next(): Promise<IteratorResult<T>> {
        if (closed) return done
        const current = stream ?? (await open())
        if (current === null) return done
        for (;;) {
          let change: Record<string, unknown>
          try {
            change = await current.next()
          } catch (err) {
            if (isClosed()) return done
            throw err
          }
          const doc = change.fullDocument
          if (doc !== undefined && doc !== null) return { value: doc as T, done: false }
        }
      },
      async return(): Promise<IteratorResult<T>> {
        closed = true
        await stream?.close()
        return done
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }

  async countDocuments(
    database: string,
    collection: string,
    filter: Record<string, unknown> = {},
  ): Promise<number> {
    const c = await this._client()
    return c.db(database).collection(collection).countDocuments(filter)
  }

  async listIndexes(database: string, collection: string): Promise<Record<string, unknown>[]> {
    const c = await this._client()
    return c.db(database).collection(collection).listIndexes().toArray()
  }

  async close(): Promise<void> {
    if (this.clientPromise === null) return
    const c = await this.clientPromise
    this.clientPromise = null
    await c.close()
  }

  private async _client(): Promise<MongoClientLike> {
    this.clientPromise ??= this._connect()
    return this.clientPromise
  }

  protected async _connect(): Promise<MongoClientLike> {
    const mod = await loadOptionalPeer(() => import('mongodb') as unknown as Promise<MongoModule>, {
      feature: 'MongoDBVFS',
      packageName: 'mongodb',
    })
    const c = new mod.MongoClient(this.uri, { driverInfo: DRIVER_INFO })
    await c.connect()
    return c
  }
}
