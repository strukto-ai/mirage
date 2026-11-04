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

import { RedisVFS as CoreRedisVFS } from '@struktoai/mirage-core/vfs/redis/redis'
import type { Connect } from './resp.ts'
import { RedisStore } from './store.ts'

export interface RedisVFSOptions {
  /** The server, `redis://` or `rediss://`: the url node and python take. */
  url?: string
  keyPrefix?: string
  /** The most bytes the mount's files may hold: a size like `100MB` or a count
   * of bytes. */
  capacity?: number | string | null
  /** The host's TCP API; Cloudflare's `connect` by default. */
  connect?: Connect
}

// Cloudflare's TCP API, imported on first use so a host without it still
// loads this module and hands its own `connect`.
const cloudflareConnect: Connect = async (hostname, port, tls) => {
  const { connect } = await import('cloudflare:sockets')
  return connect({ hostname, port }, { secureTransport: tls ? 'on' : 'off' })
}

/**
 * The edge redis mount: the shared VFS over RESP on the host's TCP API.
 *
 * It speaks to any redis, Upstash included, at the url the node and python
 * mounts take, and the keyspace is theirs, so one configuration and one
 * server serve all three.
 */
export class RedisVFS extends CoreRedisVFS {
  declare readonly store: RedisStore

  constructor(options: RedisVFSOptions = {}) {
    super(
      new RedisStore({
        url: options.url ?? 'redis://localhost:6379/0',
        keyPrefix: options.keyPrefix ?? 'mirage:fs:',
        connect: options.connect ?? cloudflareConnect,
      }),
      options.capacity ?? null,
    )
  }
}
