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
import { normalizeMongoDBConfig, resolveMongoDBConfig } from './config.ts'

describe('MongoDBConfig', () => {
  it('applies Python-parity defaults', () => {
    const r = resolveMongoDBConfig({ uri: 'mongodb://localhost' })
    expect(r.uri).toBe('mongodb://localhost')
    expect(r.databases).toBeNull()
    expect(r.defaultDocLimit).toBe(1000)
    expect(r.defaultSearchLimit).toBe(100)
    expect(r.maxDocLimit).toBe(5000)
  })

  it('keeps explicit overrides', () => {
    const r = resolveMongoDBConfig({
      uri: 'mongodb://localhost',
      databases: ['app'],
      defaultDocLimit: 50,
      defaultSearchLimit: 7,
      maxDocLimit: 200,
    })
    expect(r.databases).toEqual(['app'])
    expect(r.defaultDocLimit).toBe(50)
    expect(r.defaultSearchLimit).toBe(7)
    expect(r.maxDocLimit).toBe(200)
  })
})

describe('normalizeMongoDBConfig', () => {
  it('translates snake_case YAML keys to camelCase', () => {
    const out = normalizeMongoDBConfig({
      uri: 'mongodb://h',
      default_doc_limit: 50,
      default_search_limit: 5,
      max_doc_limit: 200,
    })
    expect(out).toEqual({
      uri: 'mongodb://h',
      defaultDocLimit: 50,
      defaultSearchLimit: 5,
      maxDocLimit: 200,
    })
  })

  it('preserves the databases array', () => {
    const out = normalizeMongoDBConfig({
      uri: 'mongodb://h',
      databases: ['app', 'analytics'],
    })
    expect(out.databases).toEqual(['app', 'analytics'])
  })
})
