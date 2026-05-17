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

import type { MongoDriver } from './_driver.ts'

async function* emptyAsyncIter<T>(): AsyncIterableIterator<T> {
  // no docs
}

export function stubMongoDriver(overrides: Partial<MongoDriver> = {}): MongoDriver {
  return {
    listDatabases: () => Promise.resolve([]),
    listCollections: () => Promise.resolve([]),
    listCollectionsDetailed: () => Promise.resolve([]),
    findDocuments: () => Promise.resolve([]),
    iterDocuments: () => emptyAsyncIter(),
    iterInserts: () => emptyAsyncIter(),
    countDocuments: () => Promise.resolve(0),
    listIndexes: () => Promise.resolve([]),
    getIndexStats: () => Promise.resolve({}),
    close: () => Promise.resolve(),
    ...overrides,
  }
}

export function arrayIter<T>(items: readonly T[]): () => AsyncIterableIterator<T> {
  return async function* () {
    for (const i of items) yield i
  }
}
