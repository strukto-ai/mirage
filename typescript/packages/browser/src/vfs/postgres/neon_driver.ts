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

import { neon, neonConfig, types, type NeonQueryFunction } from '@neondatabase/serverless'
import { readAsText } from '@struktoai/mirage-core/accessor/postgres'
import type { PgDriver, PgQueryResult } from '@struktoai/mirage-core/core/postgres/_driver'
import { stallTimeout } from '@struktoai/mirage-core/core/api/client'
import { DEFAULT_TIMEOUT } from '@struktoai/mirage-core/core/api/constants'

interface FullResultsRow<R> {
  rows: R[]
  rowCount: number | null
}

// The seconds a query may stall, riding its fetch options to the one fetch
// function the Neon client keeps for the whole page.
const STALL = Symbol('stall seconds')

type StallInit = RequestInit & { [STALL]?: number }

/**
 * Bound each Neon request's stalls by the seconds its query names
 * (`stallTimeout`). The client fetches through one function for the whole
 * page and spreads a query's `fetchOptions` into the init it hands it, so
 * this wraps the function it finds there, once, and a request that names no
 * seconds goes through as before.
 */
function boundNeonFetch(): void {
  const found = neonConfig.fetchFunction as (typeof fetch & { [STALL]?: true }) | undefined
  if (found?.[STALL] === true) return
  const previous: typeof fetch = found ?? ((input, init) => fetch(input, init))
  const bounded = (input: RequestInfo | URL, init?: StallInit): Promise<Response> => {
    const seconds = init?.[STALL]
    return seconds === undefined
      ? previous(input, init)
      : stallTimeout(seconds, previous)(input, init)
  }
  neonConfig.fetchFunction = Object.assign(bounded, { [STALL]: true as const })
}

export class NeonPgDriver implements PgDriver {
  private readonly sql: NeonQueryFunction<false, true>

  /** `timeout` is the seconds each query's request may stall. */
  constructor(
    dsn: string,
    private readonly timeout: number = DEFAULT_TIMEOUT,
  ) {
    boundNeonFetch()
    this.sql = neon(dsn, { fullResults: true, types: readAsText(types) })
  }

  async query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<R>> {
    const result = (await this.sql.query(text, params as unknown[] | undefined, {
      fetchOptions: { [STALL]: this.timeout },
    })) as unknown as FullResultsRow<R>
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}
