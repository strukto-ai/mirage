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

import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import type { PgDriver, PgQueryResult } from '@struktoai/mirage-core/core/postgres/_driver'

interface FullResultsRow<R> {
  rows: R[]
  rowCount: number | null
}

export class NeonPgDriver implements PgDriver {
  private readonly sql: NeonQueryFunction<false, true>

  constructor(dsn: string) {
    this.sql = neon(dsn, { fullResults: true })
  }

  async query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<R>> {
    const result = (await this.sql.query(
      text,
      params as unknown[] | undefined,
    )) as unknown as FullResultsRow<R>
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}
