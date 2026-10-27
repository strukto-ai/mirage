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

import { DEFAULT_PORT, LOOPBACK } from '../../vfs/redis/constants.ts'

// Name the Redis server and database a URL reaches, one way. Two mounts of
// one keyspace must compare equal however their URLs are spelled, or a move
// between them copies a key onto itself and then deletes it. The scheme and
// credentials are dropped, a missing port or db takes the default, and a
// ?db= query wins over the path as it does in redis-py.
// shortcut: only the loopback names are folded; a DNS name and its IP still
// read as two servers. Resolve them if two such mounts appear.
export function serverLocation(url: string): string {
  const parts = new URL(url)
  const query = parts.searchParams.get('db')
  if (parts.protocol === 'unix:') return `unix:${parts.pathname}/${query ?? '0'}`
  const db = query ?? (parts.pathname.replace(/^\/+|\/+$/g, '') || '0')
  // The scheme is ignored on purpose: one host and port is one store.
  let host = (parts.hostname.replace(/^\[|\]$/g, '') || 'localhost').toLowerCase()
  if (LOOPBACK.has(host)) host = 'localhost'
  return `${host}:${parts.port || String(DEFAULT_PORT)}/${db}`
}
