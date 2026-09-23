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
import { RedisVFS } from './redis.ts'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

describe.skipIf(skip)('RedisVFS', () => {
  it('connects and closes cleanly', async () => {
    const res = new RedisVFS(REDIS_URL !== undefined ? { url: REDIS_URL } : {})
    await res.open()
    const client = await res.client()
    expect(client.isOpen).toBe(true)
    await res.close()
    expect(client.isOpen).toBe(false)
  })

  it('ping round-trips via shared client', async () => {
    const res = new RedisVFS(REDIS_URL !== undefined ? { url: REDIS_URL } : {})
    try {
      const c = await res.client()
      const pong = await c.ping()
      expect(pong).toBe('PONG')
    } finally {
      await res.close()
    }
  })

  it('is idempotent on close()', async () => {
    const res = new RedisVFS(REDIS_URL !== undefined ? { url: REDIS_URL } : {})
    await res.open()
    await res.close()
    await res.close()
  })
})
