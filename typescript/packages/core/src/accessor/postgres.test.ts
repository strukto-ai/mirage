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
import { PostgresAccessor } from './postgres.ts'

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
