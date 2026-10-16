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

import { Accessor } from './base.ts'
import type { PgDriver } from '../core/postgres/_driver.ts'
import type { PostgresConfigResolved } from '../vfs/postgres/config.ts'

/**
 * The session every connection opens: read only, and the settings a date or
 * time type's text depends on, pinned so a value spells the same whatever the
 * server's defaults. Mirrors `SESSION` in `mirage/accessor/postgres.py`.
 */
export const SESSION: Readonly<Record<string, string>> = {
  default_transaction_read_only: 'on',
  DateStyle: 'ISO',
  IntervalStyle: 'postgres',
  TimeZone: 'UTC',
}

/**
 * The date and time types a row keeps as the text Postgres sends, each with
 * its OID and its array's, the text holding what a millisecond `Date` cannot:
 * a microsecond, a BC or five-digit year, infinity, 24:00:00, an interval's
 * months. Mirrors `TEXT_TYPES` in `mirage/accessor/postgres.py`.
 */
export const TEXT_TYPES: Readonly<Record<string, readonly [number, number]>> = {
  date: [1082, 1182],
  time: [1083, 1183],
  timetz: [1266, 1270],
  timestamp: [1114, 1115],
  timestamptz: [1184, 1185],
  interval: [1186, 1187],
}

/**
 * Type parsers, as pg-types and Neon's driver take them, that keep each of
 * `TEXT_TYPES` as its text, parse an array of it as `text[]` (OID 1009), and
 * leave every other type to `defaults`. Mirrors `read_as_text` in
 * `mirage/accessor/postgres.py`.
 */
export function readAsText(defaults: {
  getTypeParser: (oid: number, format?: 'text' | 'binary') => (value: string) => unknown
}): typeof defaults {
  const types = Object.values(TEXT_TYPES)
  const scalars = new Set(types.map(([oid]) => oid))
  const arrays = new Set(types.map(([, oid]) => oid))
  return {
    getTypeParser: (oid, format) => {
      if (scalars.has(oid)) return (value) => value
      return defaults.getTypeParser(arrays.has(oid) ? 1009 : oid, format)
    },
  }
}

export class PostgresAccessor extends Accessor {
  readonly driver: PgDriver
  readonly config: PostgresConfigResolved

  constructor(driver: PgDriver, config: PostgresConfigResolved) {
    super()
    this.driver = driver
    this.config = config
  }

  get store(): PgDriver {
    return this.driver
  }
}
