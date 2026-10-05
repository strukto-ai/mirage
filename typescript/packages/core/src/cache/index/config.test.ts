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
import { ZodError } from 'zod'
import { errorSummary } from '../../secrets/summary.ts'
import {
  type IndexConfig,
  IndexDirectorySchema,
  IndexEntry,
  IndexType,
  normalizeIndexConfig,
} from './config.ts'

// The one wire format: what pydantic writes for the Python IndexEntry,
// snake_case and every field. `test_config.py` pins the same literal.
const WIRE =
  '{"id":"/a.txt","name":"a.txt","resource_type":"file","remote_time":"2026-01-01T00:00:00Z","index_time":"2026-01-01T00:00:00Z","vfs_name":"","size":6,"extra":{}}'

describe('IndexEntry JSON', () => {
  it('stringifies to the JSON Python writes', () => {
    const entry = new IndexEntry({
      id: '/a.txt',
      name: 'a.txt',
      resourceType: 'file',
      remoteTime: '2026-01-01T00:00:00Z',
      indexTime: '2026-01-01T00:00:00Z',
      size: 6,
    })
    expect(JSON.stringify(entry)).toBe(WIRE)
  })

  it('reads the JSON Python writes, defaults included', () => {
    const entry = IndexEntry.fromJSON(
      '{"id":"/b.txt","name":"b.txt","resource_type":"file","extra":{"size_bytes":9}}',
    )
    expect(entry).toEqual(
      new IndexEntry({
        id: '/b.txt',
        name: 'b.txt',
        resourceType: 'file',
        extra: { size_bytes: 9 },
      }),
    )
    expect(entry.remoteTime).toBe('')
    expect(entry.size).toBeNull()
  })

  it('round-trips', () => {
    const entry = IndexEntry.fromJSON(WIRE)
    expect(JSON.stringify(entry)).toBe(WIRE)
  })

  // A row the schema refuses is an error, as `model_validate_json` raises,
  // never a hit with the field empty.
  it('refuses a row missing a required field', () => {
    expect(() => IndexEntry.fromJSON('{"id":"/c","name":"c"}')).toThrow()
  })

  it('refuses a camelCase row', () => {
    expect(() => IndexEntry.fromJSON('{"id":"/c","name":"c","resourceType":"file"}')).toThrow()
  })
})

describe('IndexDirectory JSON', () => {
  it('reads the listing Python writes', () => {
    expect(
      IndexDirectorySchema.parse(
        JSON.parse('{"entries":["/a/b"],"expires_at":4102444800.5,"generation":"g:d"}'),
      ),
    ).toEqual({
      entries: ['/a/b'],
      expires_at: 4102444800.5,
      generation: 'g:d',
      partial: false,
      version: null,
    })
  })

  it('refuses a listing missing its generation', () => {
    expect(() => IndexDirectorySchema.parse({ entries: [], expires_at: 1 })).toThrow()
  })
})

describe('normalizeIndexConfig', () => {
  it.each([
    [{ ttl: 5 }, { ttl: 5 }],
    [
      { type: IndexType.REDIS, ttl: 5, url: 'redis://localhost:6379/0', key_prefix: 's3:' },
      { type: IndexType.REDIS, ttl: 5, url: 'redis://localhost:6379/0', keyPrefix: 's3:' },
    ],
  ])('takes %j', (config, expected) => {
    expect(normalizeIndexConfig(config as IndexConfig)).toEqual(expected)
  })

  it.each([
    [{ ttll: 5 }, 'ttll: unrecognized_keys'],
    [{ keyPrefix: 's3:' }, 'keyPrefix: unrecognized_keys'],
    [{ type: IndexType.RAM, keyPrefix: 's3:' }, 'keyPrefix: unrecognized_keys'],
    [{ type: IndexType.REDIS, urll: 'redis://x' }, 'urll: unrecognized_keys'],
    [{ type: IndexType.REDIS, keyPrefix: 'a:', key_prefix: 'b:' }, 'keyPrefix: unrecognized_keys'],
    [{ type: 'redsi' }, 'type: invalid_value'],
    [{ type: null }, 'type: invalid_value'],
    [{ ttl: 'abc' }, 'ttl: invalid_type'],
    [{ type: IndexType.REDIS, key_prefix: 1 }, 'keyPrefix: invalid_type'],
  ])('refuses %j', (config, summary) => {
    expect(refusal(() => normalizeIndexConfig(config as unknown as IndexConfig))).toBe(summary)
  })
})

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (err) {
    if (err instanceof ZodError) return errorSummary(err)
    throw err
  }
  throw new Error('expected a refusal')
}
