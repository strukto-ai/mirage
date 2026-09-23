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
import { normalizePostgresConfig, resolvePostgresConfig } from './config.ts'

describe('PostgresConfig', () => {
  it('applies Python-parity defaults', () => {
    const resolved = resolvePostgresConfig({ dsn: 'postgres://localhost/db' })
    expect(resolved.dsn).toBe('postgres://localhost/db')
    expect(resolved.schemas).toBeNull()
    expect(resolved.defaultRowLimit).toBe(1000)
    expect(resolved.maxReadRows).toBe(10_000)
    expect(resolved.maxReadBytes).toBe(10 * 1024 * 1024)
    expect(resolved.defaultSearchLimit).toBe(100)
  })

  it('keeps explicit overrides', () => {
    const resolved = resolvePostgresConfig({
      dsn: 'postgres://localhost/db',
      schemas: ['public'],
      maxReadRows: 50,
      maxReadBytes: 1024,
      defaultRowLimit: 25,
      defaultSearchLimit: 7,
    })
    expect(resolved.schemas).toEqual(['public'])
    expect(resolved.defaultRowLimit).toBe(25)
    expect(resolved.maxReadRows).toBe(50)
    expect(resolved.maxReadBytes).toBe(1024)
    expect(resolved.defaultSearchLimit).toBe(7)
  })
})

describe('normalizePostgresConfig', () => {
  it('translates snake_case YAML keys to camelCase', () => {
    const out = normalizePostgresConfig({
      dsn: 'postgres://h/d',
      max_read_rows: 50,
      max_read_bytes: 2048,
      default_row_limit: 25,
      default_search_limit: 5,
    })
    expect(out).toEqual({
      dsn: 'postgres://h/d',
      maxReadRows: 50,
      maxReadBytes: 2048,
      defaultRowLimit: 25,
      defaultSearchLimit: 5,
    })
  })

  it('preserves already-camelCase keys', () => {
    const out = normalizePostgresConfig({
      dsn: 'postgres://h/d',
      maxReadRows: 50,
    })
    expect(out).toEqual({ dsn: 'postgres://h/d', maxReadRows: 50 })
  })

  it('preserves the schemas array', () => {
    const out = normalizePostgresConfig({
      dsn: 'postgres://h/d',
      schemas: ['public', 'analytics'],
    })
    expect(out.schemas).toEqual(['public', 'analytics'])
  })
})
