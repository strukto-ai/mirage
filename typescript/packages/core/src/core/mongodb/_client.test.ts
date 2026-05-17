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

import { describe, expect, it, vi } from 'vitest'
import { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { resolveMongoDBConfig, type MongoDBConfig } from '../../resource/mongodb/config.ts'
import {
  countDocuments,
  findDocuments,
  listCollections,
  listDatabases,
  listIndexes,
} from './_client.ts'
import type { MongoDriver } from './_driver.ts'
import { stubMongoDriver } from './_test_util.ts'

function makeDriver(overrides: Partial<MongoDriver> = {}): MongoDriver {
  return stubMongoDriver({
    listDatabases: vi.fn(() => Promise.resolve([])),
    listCollections: vi.fn(() => Promise.resolve([])),
    findDocuments: vi.fn(() => Promise.resolve([])),
    countDocuments: vi.fn(() => Promise.resolve(0)),
    listIndexes: vi.fn(() => Promise.resolve([])),
    close: vi.fn(() => Promise.resolve()),
    ...overrides,
  })
}

function makeAccessor(
  driver: MongoDriver,
  cfgOverrides: Partial<MongoDBConfig> = {},
): MongoDBAccessor {
  const cfg = resolveMongoDBConfig({ uri: 'mongodb://h', ...cfgOverrides })
  return new MongoDBAccessor(driver, cfg)
}

describe('listDatabases', () => {
  it('filters system dbs and returns sorted names', async () => {
    const driver = makeDriver({
      listDatabases: vi.fn(() => Promise.resolve(['admin', 'local', 'config', 'app', 'analytics'])),
    })
    const accessor = makeAccessor(driver)
    expect(await listDatabases(accessor)).toEqual(['analytics', 'app'])
  })

  it('honors the databases allowlist', async () => {
    const driver = makeDriver({
      listDatabases: vi.fn(() => Promise.resolve(['app', 'analytics', 'tmp'])),
    })
    const accessor = makeAccessor(driver, { databases: ['app'] })
    expect(await listDatabases(accessor)).toEqual(['app'])
  })
})

describe('listCollections', () => {
  it('returns sorted names', async () => {
    const driver = makeDriver({
      listCollections: vi.fn(() => Promise.resolve(['z_col', 'a_col'])),
    })
    const accessor = makeAccessor(driver)
    expect(await listCollections(accessor, 'app')).toEqual(['a_col', 'z_col'])
  })
})

describe('findDocuments', () => {
  it('caps the limit at maxDocLimit', async () => {
    const driver = makeDriver()
    const accessor = makeAccessor(driver, { maxDocLimit: 100 })
    await findDocuments(accessor, 'app', 'users', {}, { limit: 5000 })
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(driver.findDocuments).toHaveBeenCalledWith('app', 'users', {}, { limit: 100 })
  })

  it('uses maxDocLimit when no limit is provided', async () => {
    const driver = makeDriver()
    const accessor = makeAccessor(driver, { maxDocLimit: 200 })
    await findDocuments(accessor, 'app', 'users')
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(driver.findDocuments).toHaveBeenCalledWith('app', 'users', {}, { limit: 200 })
  })

  it('passes through filter, sort, projection', async () => {
    const driver = makeDriver()
    const accessor = makeAccessor(driver)
    await findDocuments(
      accessor,
      'app',
      'users',
      { active: true },
      { limit: 5, sort: { _id: -1 }, projection: { name: 1 } },
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(driver.findDocuments).toHaveBeenCalledWith(
      'app',
      'users',
      { active: true },
      { limit: 5, sort: { _id: -1 }, projection: { name: 1 } },
    )
  })
})

describe('countDocuments / listIndexes', () => {
  it('forwards to driver', async () => {
    const driver = makeDriver({
      countDocuments: vi.fn(() => Promise.resolve(42)),
      listIndexes: vi.fn(() => Promise.resolve([{ name: '_id_' }])),
    })
    const accessor = makeAccessor(driver)
    expect(await countDocuments(accessor, 'app', 'users')).toBe(42)
    expect(await listIndexes(accessor, 'app', 'users')).toEqual([{ name: '_id_' }])
  })
})
