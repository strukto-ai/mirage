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
import { resolveMongoDBConfig } from '../../vfs/mongodb/config.ts'
import type { MongoIterOptions } from './_driver.ts'
import { arrayIter, stubMongoDriver } from '../../../tests/core/mongodb/_test_util.ts'
import { DEPTH, holdsFilter, linesContaining } from './search.ts'

const DOCS = '/shop/collections/orders/documents.jsonl'

function path(virtual: string = DOCS): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: virtual.replace(/^\/+/, '') })
}

function accessorOf(
  docs: Record<string, unknown>[],
  asked: [string, string, MongoIterOptions | undefined][],
  config: Record<string, unknown> = {},
): MongoDBAccessor {
  const driver = stubMongoDriver({
    listDatabases: () => Promise.resolve(['shop']),
    listCollections: () => Promise.resolve(['orders']),
    iterDocuments: (database, collection, options) => {
      asked.push([database, collection, options])
      return arrayIter(docs)()
    },
  })
  return new MongoDBAccessor(driver, resolveMongoDBConfig({ uri: 'mongodb://h', ...config }))
}

async function drain(stream: AsyncIterable<Uint8Array> | null): Promise<string | null> {
  if (stream === null) return null
  let out = ''
  for await (const chunk of stream) out += new TextDecoder().decode(chunk)
  return out
}

function regexes(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) regexes(item, out)
  else if (typeof value === 'object' && value !== null) {
    const row = value as Record<string, unknown>
    if (typeof row.regex === 'string') out.push(row.regex)
    for (const item of Object.values(row)) regexes(item, out)
  }
  return out
}

// Twins of python/tests/core/mongodb/test_search.py.
describe('linesContaining', () => {
  it('streams the documents MongoDB names in _id order', async () => {
    const asked: [string, string, MongoIterOptions | undefined][] = []
    const accessor = accessorOf([{ _id: 1, who: 'lovelace', secret: 'x' }], asked, {
      elideFields: { 'shop.orders': ['secret'] },
    })
    expect(await drain(await linesContaining(accessor, path(), 'lovelace'))).toBe(
      '{"_id": 1, "who": "lovelace"}\n',
    )
    expect(asked).toEqual([
      ['shop', 'orders', { filter: holdsFilter(['lovelace']), sort: { _id: 1 }, batchSize: 100 }],
    ])
  })

  it.each([
    ['date', "a date's wrapper key"],
    ['oid', "an ObjectId's wrapper key"],
    ['nfinit', 'inside Infinity'],
    ['true', 'a JSON literal'],
    ['ada', 'a run of hex letters an id can hold'],
    ['x1', 'a digit'],
    ['a:b', 'punctuation'],
    ['t', "an escape's letter alone"],
  ])('declines a text outside keys and strings: %s', async (text, why) => {
    const asked: [string, string, MongoIterOptions | undefined][] = []
    expect(await linesContaining(accessorOf([], asked), path(), text), why).toBeNull()
    expect(asked).toEqual([])
  })

  it.each([
    '/shop/database.json',
    '/shop/collections/orders/schema.json',
    '/shop/collections/orders',
  ])('declines any other file: %s', async (other) => {
    const asked: [string, string, MongoIterOptions | undefined][] = []
    expect(await linesContaining(accessorOf([], asked), path(other), 'lovelace')).toBeNull()
    expect(asked).toEqual([])
  })
})

describe('holdsFilter', () => {
  it('walks every key and string to a depth', () => {
    let expr = holdsFilter(['lovelace']).$expr as Record<string, unknown>
    let levels = 0
    while ('$let' in expr) {
      levels += 1
      expr = (expr.$let as Record<string, unknown>).in as Record<string, unknown>
    }
    // The seed level, then one per depth; a document nested deeper is a
    // candidate.
    expect(levels).toBe(DEPTH + 1)
    expect(expr).toEqual({
      $or: [`$$s${String(DEPTH)}.hit`, { $gt: [{ $size: `$$s${String(DEPTH)}.next` }, 0] }],
    })
  })

  // A line spells a character outside ASCII as \uXXXX on one host, so a text
  // starting with u or a hex letter may begin inside the escape.
  it.each<[string[], boolean]>([
    [['bob'], true],
    [['unicode'], true],
    [['need'], false],
    [['need', 'eed'], true],
  ])('takes non-ASCII strings for %j: %s', (queries, escaped) => {
    expect(regexes(holdsFilter(queries)).includes('[^\\x00-\\x7f]')).toBe(escaped)
  })
})
