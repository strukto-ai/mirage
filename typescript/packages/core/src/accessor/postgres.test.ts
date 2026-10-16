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
import type { PgDriver } from '../core/postgres/_driver.ts'
import { resolvePostgresConfig } from '../vfs/postgres/config.ts'
import { PostgresAccessor, readAsText, SESSION, TEXT_TYPES } from './postgres.ts'

describe('PostgresAccessor', () => {
  it('holds the driver and resolved config', () => {
    const config = resolvePostgresConfig({ dsn: 'postgres://localhost/db' })
    const driver: PgDriver = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      close: () => Promise.resolve(),
    }
    const accessor = new PostgresAccessor(driver, config)
    expect(accessor.driver).toBe(driver)
    expect(accessor.store).toBe(driver)
    expect(accessor.config).toBe(config)
  })
})

describe('readAsText', () => {
  const defaults = {
    getTypeParser:
      (oid: number, format?: 'text' | 'binary') =>
      (value: string): unknown =>
        `${String(oid)} ${format ?? ''} ${value}`,
  }
  const parsers = readAsText(defaults)

  it('keeps each date and time type as the text Postgres sends', () => {
    expect(Object.keys(TEXT_TYPES)).toEqual([
      'date',
      'time',
      'timetz',
      'timestamp',
      'timestamptz',
      'interval',
    ])
    for (const [oid] of Object.values(TEXT_TYPES)) {
      expect(parsers.getTypeParser(oid, 'text')('2026-01-01 00:00:00.000001+00')).toBe(
        '2026-01-01 00:00:00.000001+00',
      )
    }
  })

  it('parses an array of one as text[]', () => {
    for (const [, oid] of Object.values(TEXT_TYPES)) {
      expect(parsers.getTypeParser(oid, 'text')('{infinity}')).toBe('1009 text {infinity}')
    }
  })

  it('leaves every other type to the defaults', () => {
    expect(parsers.getTypeParser(23, 'text')('1')).toBe('23 text 1')
    expect(parsers.getTypeParser(1009, 'text')('{a}')).toBe('1009 text {a}')
  })

  it('pins the settings a date or time text depends on', () => {
    expect(SESSION).toEqual({
      default_transaction_read_only: 'on',
      DateStyle: 'ISO',
      IntervalStyle: 'postgres',
      TimeZone: 'UTC',
    })
  })
})
