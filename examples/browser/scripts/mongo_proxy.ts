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

import type { IncomingMessage, ServerResponse } from 'node:http'
import { setServers } from 'node:dns'

setServers(['8.8.8.8', '1.1.1.1'])

interface MongoCollectionLike {
  find: (
    filter: Record<string, unknown>,
    options?: { projection?: Record<string, unknown> },
  ) => MongoCursorLike
  countDocuments: (filter?: Record<string, unknown>) => Promise<number>
  listIndexes: () => { toArray: () => Promise<Record<string, unknown>[]> }
}
interface MongoCursorLike {
  sort: (sort: Record<string, 1 | -1>) => MongoCursorLike
  skip: (n: number) => MongoCursorLike
  limit: (n: number) => MongoCursorLike
  toArray: () => Promise<Record<string, unknown>[]>
}
interface MongoDbLike {
  listCollections: () => { toArray: () => Promise<{ name: string }[]> }
  collection: (name: string) => MongoCollectionLike
  admin: () => { listDatabases: () => Promise<{ databases: { name: string }[] }> }
}
interface MongoClientLike {
  connect: () => Promise<MongoClientLike>
  db: (name?: string) => MongoDbLike
  close: () => Promise<void>
}
interface MongoModule {
  MongoClient: new (uri: string) => MongoClientLike
}

let clientPromise: Promise<MongoClientLike | null> | null = null

async function getClient(): Promise<MongoClientLike | null> {
  if (clientPromise !== null) return clientPromise
  const uri = process.env.MONGODB_URI
  if (uri === undefined || uri === '') return Promise.resolve(null)
  clientPromise = (async () => {
    const mod = (await import('mongodb')) as unknown as MongoModule
    const c = new mod.MongoClient(uri)
    const deadline = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('mongo connect timeout (10s)')), 10_000)
    })
    await Promise.race([c.connect(), deadline])
    return c
  })()
  clientPromise.catch(() => {
    clientPromise = null
  })
  return clientPromise
}

interface MongoProxyRequest {
  op: string
  database?: string
  collection?: string
  filter?: Record<string, unknown>
  options?: {
    limit?: number
    sort?: Record<string, 1 | -1>
    skip?: number
    projection?: Record<string, unknown>
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function handle(payload: MongoProxyRequest): Promise<unknown> {
  const c = await getClient()
  if (c === null) {
    throw new Error('MONGODB_URI not set in .env.development; proxy disabled')
  }
  switch (payload.op) {
    case 'listDatabases': {
      const r = await c.db().admin().listDatabases()
      return r.databases.map((d) => d.name)
    }
    case 'listCollections': {
      const cols = await c.db(payload.database!).listCollections().toArray()
      return cols.map((col) => col.name)
    }
    case 'findDocuments': {
      let cursor: MongoCursorLike = c
        .db(payload.database!)
        .collection(payload.collection!)
        .find(payload.filter ?? {}, {
          ...(payload.options?.projection !== undefined
            ? { projection: payload.options.projection }
            : {}),
        })
      const opts = payload.options ?? {}
      if (opts.sort !== undefined) cursor = cursor.sort(opts.sort)
      if (opts.skip !== undefined) cursor = cursor.skip(opts.skip)
      if (opts.limit !== undefined) cursor = cursor.limit(opts.limit)
      return cursor.toArray()
    }
    case 'countDocuments':
      return c
        .db(payload.database!)
        .collection(payload.collection!)
        .countDocuments(payload.filter ?? {})
    case 'listIndexes':
      return c
        .db(payload.database!)
        .collection(payload.collection!)
        .listIndexes()
        .toArray()
    default:
      throw new Error(`unknown op: ${payload.op}`)
  }
}

export async function handleMongoProxy(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.url !== '/api/mongo' || req.method !== 'POST') return false
  try {
    const body = await readBody(req)
    const payload = JSON.parse(body) as MongoProxyRequest
    const result = await handle(payload)
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(result))
  } catch (err) {
    res.statusCode = 500
    res.end(err instanceof Error ? err.message : String(err))
  }
  return true
}
