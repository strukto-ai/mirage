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

import { MountMode } from '@struktoai/mirage-core/types'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { MongoDBVFS } from './mongodb.ts'

// vitest 4 types a bare `vi.fn()` as neither callable nor constructable.
type AnyMock = Mock<(...args: never[]) => unknown>

interface MockClient {
  connect: AnyMock
  db: AnyMock
  close: AnyMock
}

const clients: MockClient[] = []

const ClientCtor = vi.fn(function (_uri: string) {
  const profilesDocs = [
    { _id: '1', name: 'alice', email: 'alice@example.com' },
    { _id: '2', name: 'bob', email: 'bob@example.com' },
    { _id: '3', name: 'carol', email: 'carol@example.com' },
  ]
  const makeCursor = (docs: Record<string, unknown>[]) => {
    let arr = [...docs]
    const cursor = {
      sort: vi.fn(() => cursor),
      skip: vi.fn((n: number) => {
        arr = arr.slice(n)
        return cursor
      }),
      limit: vi.fn((n: number) => {
        arr = arr.slice(0, n)
        return cursor
      }),
      batchSize: vi.fn(() => cursor),
      toArray: vi.fn(() => Promise.resolve(arr)),
    }
    return cursor
  }
  const makeColl = (docs: Record<string, unknown>[]) => ({
    find: vi.fn(() => makeCursor(docs)),
    countDocuments: vi.fn(() => Promise.resolve(docs.length)),
    listIndexes: vi.fn(() => ({ toArray: () => Promise.resolve([{ name: '_id_' }]) })),
    aggregate: vi.fn(() => ({ toArray: () => Promise.resolve([]) })),
    watch: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        // no events
      },
      close: () => Promise.resolve(),
    })),
  })
  const profilesCollection = makeColl(profilesDocs)
  const sessionsCollection = makeColl([])
  const db = {
    listCollections: vi.fn(() => ({
      toArray: () =>
        Promise.resolve([
          { name: 'profiles', type: 'collection' },
          { name: 'sessions', type: 'collection' },
        ]),
    })),
    collection: vi.fn((name: string) =>
      name === 'profiles' ? profilesCollection : sessionsCollection,
    ),
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

describe('MongoDBVFS mount integration', () => {
  let ws: Workspace
  let vfs: MongoDBVFS

  beforeEach(() => {
    clients.length = 0
    ClientCtor.mockClear()
    vfs = new MongoDBVFS({ uri: 'mongodb://h' })
    ws = new Workspace({ '/mongo': vfs }, { mode: MountMode.READ })
  })

  afterEach(async () => {
    await ws.close()
  })

  it('readdir /mongo returns user databases (admin/local/config filtered)', async () => {
    const r = await ws.shell('ls /mongo')
    const stdout = new TextDecoder().decode(r.stdout)
    expect(stdout).toContain('app')
    expect(stdout).toContain('analytics')
    expect(stdout).not.toContain('admin')
  })

  it('readdir /mongo/app exposes database.json / collections / views', async () => {
    const r = await ws.shell('ls /mongo/app')
    const stdout = new TextDecoder().decode(r.stdout)
    expect(stdout).toContain('database.json')
    expect(stdout).toContain('collections')
    expect(stdout).toContain('views')
  })

  it('readdir /mongo/app/collections lists collection names', async () => {
    const r = await ws.shell('ls /mongo/app/collections')
    const stdout = new TextDecoder().decode(r.stdout)
    expect(stdout).toContain('profiles')
    expect(stdout).toContain('sessions')
  })

  it('cat documents.jsonl returns one BSON-faithful JSON line per doc', async () => {
    const r = await ws.shell('cat /mongo/app/collections/profiles/documents.jsonl')
    const text = new TextDecoder().decode(r.stdout).trim()
    const lines = text.split('\n')
    expect(lines).toHaveLength(3)
    const first = JSON.parse(lines[0] ?? '') as { name: string }
    expect(first.name).toBe('alice')
  })

  it('head -n 2 pushes down to find().limit(2)', async () => {
    const r = await ws.shell('head -n 2 /mongo/app/collections/profiles/documents.jsonl')
    const lines = new TextDecoder().decode(r.stdout).trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('wc -l pushes down to countDocuments', async () => {
    const r = await ws.shell('wc -l /mongo/app/collections/profiles/documents.jsonl')
    expect(new TextDecoder().decode(r.stdout).trim()).toBe(
      '3 /mongo/app/collections/profiles/documents.jsonl',
    )
  })
})
