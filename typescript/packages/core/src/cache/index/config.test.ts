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

import { ContentType, FileStat, FileType } from '../../types.ts'
import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { errorSummary } from '../../secrets/summary.ts'
import {
  FileStatWireSchema,
  type IndexConfig,
  IndexDirectorySchema,
  IndexType,
  normalizeIndexConfig,
} from './config.ts'

// The one wire format a row is stored in: what pydantic writes for a
// FileStat, snake_case and every field. `test_config.py` pins the same literal.
const WIRE =
  '{"name":"a.txt","size":6,"modified":"2026-01-01T00:00:00Z","fingerprint":"v1","revision":null,"type":"file","content":"text","mode":null,"uid":null,"gid":null,"atime":null,"ctime":null,"birthtime":null,"dev":null,"extra":{}}'

describe('row JSON', () => {
  it('stringifies to the JSON Python writes, and reads it back', () => {
    const row = new FileStat({
      name: 'a.txt',
      size: 6,
      modified: '2026-01-01T00:00:00Z',
      fingerprint: 'v1',
      type: FileType.FILE,
      content: ContentType.TEXT,
    })
    expect(JSON.stringify(row)).toBe(WIRE)
    expect(new FileStat(FileStatWireSchema.parse(JSON.parse(WIRE)))).toEqual(row)
  })

  // A row the schema refuses is an error, as `model_validate_json` raises,
  // never a hit with the field empty.
  it('refuses a row missing its type', () => {
    expect(() => FileStatWireSchema.parse(JSON.parse('{"name":"c"}'))).toThrow()
  })
})

describe('IndexDirectory JSON', () => {
  it('reads the listing Python writes', () => {
    expect(
      IndexDirectorySchema.parse(
        JSON.parse(
          '{"entries":["/a/b"],"folders":[0],"expires_at":4102444800.5,"generation":"g:d"}',
        ),
      ),
    ).toEqual({
      entries: ['/a/b'],
      folders: [0],
      expires_at: 4102444800.5,
      generation: 'g:d',
      partial: false,
      version: null,
      window: false,
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
