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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MountMode } from '@struktoai/mirage-core'
import { RedisResource } from '../resource/redis/redis.ts'
import { Workspace } from '../workspace.ts'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

const DEC = new TextDecoder()
const RUN_ID = `mirage-missing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(skip)('redis streaming commands on missing files', () => {
  let redis: RedisResource
  let ws: Workspace

  beforeEach(async () => {
    redis = new RedisResource(
      REDIS_URL !== undefined ? { url: REDIS_URL, keyPrefix: `${RUN_ID}:` } : {},
    )
    await redis.open()
    ws = new Workspace({ '/redis': redis }, { mode: MountMode.WRITE })
  })

  afterEach(async () => {
    await ws.close()
    await redis.close()
  })

  it('cat /missing.txt returns exit=1 with stderr', async () => {
    const res = await ws.execute('cat /redis/missing.txt')
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toMatch(/No such file or directory/)
  })

  it('cat /missing; echo after=$? yields after=1', async () => {
    const res = await ws.execute('cat /redis/missing.txt; echo after=$?')
    expect(DEC.decode(res.stdout)).toBe('after=1\n')
  })

  it('cat /missing || echo fallback', async () => {
    const res = await ws.execute('cat /redis/missing.txt || echo fallback')
    expect(DEC.decode(res.stdout)).toBe('fallback\n')
  })

  it('head /missing returns exit=1', async () => {
    const res = await ws.execute('head /redis/missing.txt')
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toMatch(/No such file or directory/)
  })

  // GNU grep exits 2 for an operand it could not search, unlike the read
  // commands around it, which exit 1.
  it('grep pat /missing returns exit=2', async () => {
    const res = await ws.execute('grep foo /redis/missing.txt')
    expect(res.exitCode).toBe(2)
    expect(DEC.decode(res.stderr)).toMatch(/No such file or directory/)
  })

  it('tail /missing returns exit=1', async () => {
    const res = await ws.execute('tail /redis/missing.txt')
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toMatch(/No such file or directory/)
  })

  it('wc /missing returns exit=1', async () => {
    const res = await ws.execute('wc /redis/missing.txt')
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toMatch(/No such file or directory/)
  })
})
