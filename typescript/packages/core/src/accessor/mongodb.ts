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
import { ResponseCache } from './responses.ts'
import type { MongoDriver } from '../core/mongodb/_driver.ts'
import type { MongoDBConfigResolved } from '../vfs/mongodb/config.ts'

export class MongoDBAccessor extends Accessor {
  readonly driver: MongoDriver
  readonly config: MongoDBConfigResolved
  /** The database and collection names a listing or an existence check reads. */
  readonly listings: ResponseCache<string, string[]>

  constructor(
    driver: MongoDriver,
    config: MongoDBConfigResolved,
    options: { listingCacheTtlMs?: number } = {},
  ) {
    super()
    this.driver = driver
    this.config = config
    this.listings = new ResponseCache((options.listingCacheTtlMs ?? 5000) / 1000)
  }

  override caches(): readonly ResponseCache<unknown, unknown>[] {
    return [this.listings]
  }
}
