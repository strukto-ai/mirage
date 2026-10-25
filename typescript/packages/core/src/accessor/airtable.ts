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
import type { AirtableConfig } from '../core/airtable/config.ts'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_READ_RECORDS,
  DEFAULT_REQUESTS_PER_SECOND,
} from '../core/airtable/constants.ts'
import { RateLimiter } from '../core/api/rate_limit.ts'
import type { Clock } from '../utils/clock.ts'

/**
 * The account, its bounds with defaults applied, and the per-base pacing
 * every call rides. `fetchFn` keeps the transport's injection seam.
 */
export class AirtableAccessor extends Accessor {
  readonly config: AirtableConfig
  readonly baseUrl: string
  readonly baseIds: readonly string[] | null
  readonly maxReadRecords: number
  readonly limiter: RateLimiter
  readonly fetchFn: typeof fetch | undefined

  constructor(config: AirtableConfig, options: { fetchFn?: typeof fetch } = {}) {
    super()
    this.config = config
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
    this.baseIds = config.baseIds ?? null
    this.maxReadRecords = config.maxReadRecords ?? DEFAULT_MAX_READ_RECORDS
    this.limiter = new RateLimiter(config.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND)
    this.fetchFn = options.fetchFn
  }

  /** Pace each base's calls on the workspace's clock. */
  override bindClock(clock: Clock): void {
    this.limiter.bindClock(clock)
  }
}
