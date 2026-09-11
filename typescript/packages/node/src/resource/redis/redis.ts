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

import { RedisResourceBase } from '@struktoai/mirage-core/resource/redis/redis'
import type { RedisClientType } from 'redis'
import { RedisStore } from './store.ts'

export type { RedisResourceState } from '@struktoai/mirage-core/resource/redis/redis'

export interface RedisResourceOptions {
  url?: string
  keyPrefix?: string
}

export interface RedisModule {
  createClient: (options: { url: string }) => RedisClientType
  RESP_TYPES: { readonly BLOB_STRING: number }
}

/**
 * The node redis mount: the shared resource over a RESP client.
 *
 * Everything filesystem-shaped lives in core's `RedisResourceBase`; this class
 * only knows how to reach a server from a redis URL and hands the raw client
 * to the subclasses that need one, such as the file cache.
 */
export class RedisResource extends RedisResourceBase {
  declare readonly store: RedisStore

  constructor(options: RedisResourceOptions = {}) {
    super(
      new RedisStore({
        url: options.url ?? 'redis://localhost:6379/0',
        keyPrefix: options.keyPrefix ?? 'mirage:fs:',
      }),
    )
  }

  client(): Promise<RedisClientType> {
    return this.store.client()
  }

  protected module(): Promise<RedisModule> {
    return import('redis') as unknown as Promise<RedisModule>
  }
}
