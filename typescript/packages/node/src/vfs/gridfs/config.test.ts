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
import { normalizeGridFSConfig, redactConfig } from './config.ts'

describe('normalizeGridFSConfig', () => {
  it('renames snake_case fields', () => {
    const config = normalizeGridFSConfig({
      uri: 'mongodb://h',
      database: 'db',
      key_prefix: 'team/reports',
      chunk_size_bytes: 1024,
    })
    expect(config.keyPrefix).toBe('team/reports/')
    expect(config.chunkSizeBytes).toBe(1024)
  })

  it('passes camelCase through and normalizes the prefix', () => {
    const config = normalizeGridFSConfig({
      uri: 'mongodb://h',
      database: 'db',
      keyPrefix: '/team/reports/',
    })
    expect(config.keyPrefix).toBe('team/reports/')
  })

  it('drops an empty prefix', () => {
    const config = normalizeGridFSConfig({ uri: 'mongodb://h', database: 'db', key_prefix: '' })
    expect(config.keyPrefix).toBeUndefined()
  })
})

describe('redactConfig', () => {
  it('redacts the uri', () => {
    const redacted = redactConfig({ uri: 'mongodb://user:pass@h', database: 'db' })
    expect(redacted.uri).not.toContain('pass')
    expect(redacted.database).toBe('db')
  })
})
