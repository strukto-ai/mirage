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

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { MongoDBStore } from './store.ts'

// vitest 4 types a bare `vi.fn()` as neither callable nor constructable.
type AnyMock = Mock<(...args: never[]) => unknown>

interface MockClient {
  connect: AnyMock
  db: AnyMock
  close: AnyMock
}

const clients: MockClient[] = []

const ClientCtor = vi.fn(function (_uri: string) {
  const cursor = {
    sort: vi.fn(() => cursor),
    skip: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    toArray: vi.fn(() => Promise.resolve<{ _id: string }[]>([{ _id: '1' }, { _id: '2' }])),
  }
  const collection = {
    find: vi.fn(() => cursor),
    countDocuments: vi.fn(() => Promise.resolve(5)),
    listIndexes: vi.fn(() => ({ toArray: () => Promise.resolve([{ name: '_id_' }]) })),
  }
  const db = {
    listCollections: vi.fn(() => ({
      toArray: () => Promise.resolve([{ name: 'profiles' }, { name: 'sessions' }]),
    })),
    collection: vi.fn(() => collection),
    admin: vi.fn(() => ({
      listDatabases: vi.fn(() =>
        Promise.resolve({
          databases: [{ name: 'admin' }, { name: 'app' }, { name: 'analytics' }],
        }),
      ),
    })),
  }
  const client: MockClient = {
    connect: vi.fn(() => Promise.resolve(client)),
    db: vi.fn(() => db),
    close: vi.fn(() => Promise.resolve()),
  }
  clients.push(client)
  return client
})

vi.mock('mongodb', () => ({
  MongoClient: ClientCtor,
}))

describe('MongoDBStore', () => {
  beforeEach(() => {
    clients.length = 0
    ClientCtor.mockClear()
  })

  afterEach(async () => {
    await Promise.all(
      clients.map((c) => {
        const ret = c.close()
        return ret instanceof Promise ? ret : Promise.resolve(ret)
      }),
    )
  })

  it('does not connect until first method', () => {
    const store = new MongoDBStore('mongodb://h')
    void store
    expect(ClientCtor).not.toHaveBeenCalled()
  })

  it('lazily connects once across multiple calls', async () => {
    const store = new MongoDBStore('mongodb://h')
    await store.listDatabases()
    await store.listCollections('app')
    expect(ClientCtor).toHaveBeenCalledTimes(1)
    expect(clients[0]?.connect).toHaveBeenCalledTimes(1)
  })

  it('listDatabases returns names', async () => {
    const store = new MongoDBStore('mongodb://h')
    expect(await store.listDatabases()).toEqual(['admin', 'app', 'analytics'])
  })

  it('listCollections returns sorted-ish names from driver', async () => {
    const store = new MongoDBStore('mongodb://h')
    expect(await store.listCollections('app')).toEqual(['profiles', 'sessions'])
  })

  it('findDocuments forwards filter + options to cursor', async () => {
    const store = new MongoDBStore('mongodb://h')
    const docs = await store.findDocuments(
      'app',
      'profiles',
      { active: true },
      {
        limit: 10,
        sort: { _id: -1 },
        skip: 5,
      },
    )
    expect(docs).toEqual([{ _id: '1' }, { _id: '2' }])
  })

  it('countDocuments forwards filter', async () => {
    const store = new MongoDBStore('mongodb://h')
    expect(await store.countDocuments('app', 'profiles', { active: true })).toBe(5)
  })

  it('close resets client and reconnects on next use', async () => {
    const store = new MongoDBStore('mongodb://h')
    await store.listDatabases()
    await store.close()
    expect(clients[0]?.close).toHaveBeenCalledTimes(1)
    await store.listDatabases()
    expect(ClientCtor).toHaveBeenCalledTimes(2)
  })
})
