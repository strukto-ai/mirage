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
import { UpstashRedisStore, type UpstashRedisStoreOptions } from './store.ts'

export type { RedisResourceState } from '@struktoai/mirage-core/resource/redis/redis'

export type RedisResourceOptions = UpstashRedisStoreOptions

/**
 * The browser redis mount: the shared resource over Upstash's REST api.
 *
 * A page cannot open a socket, so the store speaks HTTP to Upstash, or to
 * serverless-redis-http in front of any redis. It takes the redis url the
 * node and python mounts take, and the keyspace is the one they use, so one
 * configuration and one database serve all three.
 */
export class RedisResource extends RedisResourceBase {
  declare readonly store: UpstashRedisStore

  constructor(options: RedisResourceOptions) {
    super(new UpstashRedisStore(options))
  }
}
