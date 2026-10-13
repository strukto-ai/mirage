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

import { describe, expect, it } from 'vitest'
import { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { resolveMongoDBConfig } from '../../vfs/mongodb/config.ts'
import { arrayIter, stubMongoDriver } from './_test_util.ts'
import { follow, lastLines, lineCount, readStream } from './stream.ts'

function docs(database: string, kind = 'collections', name = 'users'): PathSpec {
  const virtual = `/mongo/${database}/${kind}/${name}/documents.jsonl`
  return new PathSpec({
    virtual,
    directory: `/mongo/${database}/${kind}/${name}/`,
    resolved: true,
    vfsPath: mountKey(virtual, '/mongo'),
  })
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += new TextDecoder().decode(chunk)
  return out
}

describe('mongodb document streams', () => {
  const queried: string[] = []
  const driver = stubMongoDriver({
    listDatabases: () => Promise.resolve(['app', 'secret']),
    listCollections: () => Promise.resolve(['users']),
    iterDocuments: (database) => {
      queried.push(database)
      return arrayIter([{ _id: 1, name: 'ada' }])()
    },
    iterInserts: (database) => {
      queried.push(database)
      return arrayIter([{ _id: 2, name: 'ben' }])()
    },
    findDocuments: (database) => {
      queried.push(database)
      return Promise.resolve([])
    },
    countDocuments: (database) => {
      queried.push(database)
      return Promise.resolve(0)
    },
  })
  const accessor = new MongoDBAccessor(
    driver,
    resolveMongoDBConfig({ uri: 'mongodb://h', databases: ['app'] }),
  )

  // The streams went straight to the collection the path names, so a
  // database `databases` leaves out streamed while `ls` and `stat` said it was
  // not there.
  it('refuses a collection outside databases before querying it', async () => {
    const secret = docs('secret')
    await expect(drain(readStream(accessor, secret))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(follow(accessor, secret, 5)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lastLines(accessor, secret, 5)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lineCount(accessor, secret)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(queried).toEqual([])
    expect(await drain(readStream(accessor, docs('app')))).toContain('"ada"')
    expect(queried).toEqual(['app'])
  })
})

describe('mongodb read stand-ins', () => {
  function accessorOver(
    found: Record<string, unknown>[],
    count: number,
    maxDocLimit = 5000,
  ): [MongoDBAccessor, unknown[]] {
    const asked: unknown[] = []
    const driver = stubMongoDriver({
      listDatabases: () => Promise.resolve(['app']),
      listCollections: () => Promise.resolve(['users']),
      listCollectionsDetailed: () => Promise.resolve([{ name: 'recent', type: 'view' }]),
      findDocuments: <T>(
        _database: string,
        _collection: string,
        _filter?: Record<string, unknown>,
        options?: unknown,
      ) => {
        asked.push(options)
        return Promise.resolve(found as T[])
      },
      countDocuments: () => Promise.resolve(count),
      iterInserts: () => arrayIter([{ _id: 7, name: 'gus' }])(),
    })
    return [
      new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h', maxDocLimit })),
      asked,
    ]
  }

  it('takes the last documents in ascending order', async () => {
    const [accessor, asked] = accessorOver(
      [
        { _id: 5, name: 'e' },
        { _id: 4, name: 'd' },
      ],
      5,
    )
    const out = new TextDecoder().decode((await lastLines(accessor, docs('app'), 2)) ?? undefined)
    expect(out.split('\n')).toEqual(['{"_id": 4, "name": "d"}', '{"_id": 5, "name": "e"}', ''])
    expect(asked).toEqual([{ limit: 2, sort: { _id: -1 } }])
  })

  it('refuses a count past maxDocLimit the collection fills', async () => {
    const [accessor] = accessorOver([], 10, 2)
    await expect(lastLines(accessor, docs('app'), 5)).rejects.toMatchObject({ code: 'EFBIG' })
  })

  it('counts and follows a collection', async () => {
    const [accessor] = accessorOver([], 7)
    expect(await lineCount(accessor, docs('app'))).toBe(7)
    const added = await follow(accessor, docs('app'), 0)
    expect(added).not.toBeNull()
    if (added !== null) expect(await drain(added)).toBe('{"_id": 7, "name": "gus"}\n')
  })

  // Mirrors test_follow_prints_the_last_documents_then_leaves_them_out.
  it('follows from the last documents, then leaves them out', async () => {
    const times = ['t1', 't2']
    const asked: unknown[][] = []
    const driver = stubMongoDriver({
      listDatabases: () => Promise.resolve(['app']),
      listCollections: () => Promise.resolve(['users']),
      findDocuments: <T>() =>
        Promise.resolve([
          { _id: 7, name: 'gus' },
          { _id: 6, name: 'fay' },
        ] as T[]),
      operationTime: () => Promise.resolve(times.shift()),
      iterInserts: <T>(_database: string, _collection: string, ...rest: unknown[]) => {
        asked.push(rest)
        return arrayIter([{ _id: 8, name: 'hal' }])<T>()
      },
    })
    const accessor = new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h' }))
    const added = await follow(accessor, docs('app'), 2)
    if (added === null) throw new Error('expected a follow')
    expect(await drain(added)).toBe(
      '{"_id": 6, "name": "fay"}\n{"_id": 7, "name": "gus"}\n{"_id": 8, "name": "hal"}\n',
    )
    expect(asked).toEqual([['t1', [6, 7], 't2']])
  })

  // Mirrors test_follow_prints_an_insert_that_renders_like_a_printed_one.
  it('prints an insert that renders like a printed one', async () => {
    const driver = stubMongoDriver({
      listDatabases: () => Promise.resolve(['app']),
      listCollections: () => Promise.resolve(['users']),
      findDocuments: <T>() => Promise.resolve([{ _id: 1, name: 'gus' }] as T[]),
      iterInserts: <T>() => arrayIter([{ _id: 2, name: 'gus' }])<T>(),
    })
    const accessor = new MongoDBAccessor(
      driver,
      resolveMongoDBConfig({ uri: 'mongodb://h', elideFields: { 'app.users': ['_id'] } }),
    )
    const added = await follow(accessor, docs('app'), 1)
    if (added === null) throw new Error('expected a follow')
    expect(await drain(added)).toBe('{"name": "gus"}\n{"name": "gus"}\n')
  })

  it('ends a wait for the next insert when closed', async () => {
    let wake = (): void => undefined
    const driver = stubMongoDriver({
      listDatabases: () => Promise.resolve(['app']),
      listCollections: () => Promise.resolve(['users']),
      iterInserts: <T>(): AsyncIterableIterator<T> => ({
        next: () =>
          new Promise((resolve) => {
            wake = () => {
              resolve({ value: undefined, done: true })
            }
          }),
        return: () => {
          wake()
          return Promise.resolve({ value: undefined, done: true })
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }),
    })
    const accessor = new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h' }))
    const added = await follow(accessor, docs('app'), 0)
    if (added === null) throw new Error('expected a follow')
    const pulling = added.next()
    await Promise.resolve()
    await added.return?.()
    expect((await pulling).done).toBe(true)
  })

  it('follows from the operation time it was asked at', async () => {
    const calls: string[] = []
    const seen: unknown[] = []
    const driver = stubMongoDriver({
      listDatabases: () => Promise.resolve(['app']),
      listCollections: () => Promise.resolve(['users']),
      operationTime: () => {
        calls.push('ping')
        return Promise.resolve('t42')
      },
      iterInserts: <T>(_database: string, _collection: string, after?: unknown) => {
        calls.push('watch')
        seen.push(after)
        return arrayIter([{ _id: 1 }])<T>()
      },
    })
    const accessor = new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h' }))
    const added = await follow(accessor, docs('app'), 0)
    expect(calls).toEqual(['ping'])
    expect(added).not.toBeNull()
    if (added !== null) expect(await drain(added)).toBe('{"_id": 1}\n')
    expect(calls).toEqual(['ping', 'watch'])
    expect(seen).toEqual(['t42'])
  })

  it('leaves another file to the read and a view to the polls', async () => {
    const [accessor] = accessorOver([], 3)
    const schema = new PathSpec({
      virtual: '/mongo/app/collections/users/schema.json',
      directory: '/mongo/app/collections/users/',
      resolved: true,
      vfsPath: 'app/collections/users/schema.json',
    })
    expect(await lastLines(accessor, schema, 2)).toBeNull()
    expect(await lineCount(accessor, schema)).toBeNull()
    expect(await follow(accessor, docs('app', 'views', 'recent'), 5)).toBeNull()
  })
})
