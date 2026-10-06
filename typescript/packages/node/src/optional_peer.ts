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

import type { RedisClientType } from 'redis'
import { loadOptionalPeer } from '@struktoai/mirage-core/utils/optional_peer'

export { loadOptionalPeer }

/**
 * A connected node-redis client for `url`, reconnection off. node-redis throws
 * an `error` nobody listens for, which would end the process, so `onError`
 * hears it instead: the client is dead after one, and the caller drops it and
 * connects afresh on its next call.
 */
export async function connectRedis(
  url: string,
  feature: string,
  onError: () => void,
): Promise<RedisClientType> {
  const mod = await loadOptionalPeer(
    () =>
      import('redis') as unknown as Promise<{
        createClient: (o: { url: string }) => RedisClientType
      }>,
    { feature, packageName: 'redis' },
  )
  const c = mod.createClient({
    url,
    socket: { reconnectStrategy: false },
  } as Parameters<typeof mod.createClient>[0])
  c.on('error', onError)
  await c.connect()
  return c
}
