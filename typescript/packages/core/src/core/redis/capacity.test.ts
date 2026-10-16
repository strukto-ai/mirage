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
import { RedisAccessor } from '../../accessor/redis.ts'
import { CapacityState } from '../../types.ts'
import type { RedisStoreLike } from '../../vfs/redis/store.ts'
import { capacity } from './capacity.ts'

function answering(answer: string | Error): RedisAccessor {
  return new RedisAccessor({
    keyPrefix: 'cap:',
    infoMemory: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  } as unknown as RedisStoreLike)
}

function info(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([name, value]) => `${name}:${value}`)
  return ['# Memory', ...lines, ''].join('\r\n')
}

describe('redis capacity', () => {
  it('takes a memory limit as the capacity', async () => {
    const text = info({ used_memory: '300', used_memory_human: '300B', maxmemory: '1000' })
    expect(await capacity(answering(text))).toEqual({
      state: CapacityState.QUOTA,
      total: 1000,
      used: 300,
      available: 700,
    })
  })

  it('leaves nothing available past the limit', async () => {
    expect(await capacity(answering(info({ used_memory: '1200', maxmemory: '1000' })))).toEqual({
      state: CapacityState.QUOTA,
      total: 1000,
      used: 1200,
      available: 0,
    })
  })

  it('is elastic with no limit', async () => {
    expect(await capacity(answering(info({ used_memory: '300', maxmemory: '0' })))).toEqual({
      state: CapacityState.ELASTIC,
    })
  })

  it.each<[string, string | Error]>([
    ['no maxmemory', info({ used_memory: '300' })],
    ['no used_memory', info({ maxmemory: '1000' })],
    ['a non-number', info({ used_memory: '300B', maxmemory: '1000' })],
    ['a refused INFO', new Error("ERR unknown command 'INFO'")],
  ])('is unknown on %s', async (_name, answer) => {
    expect(await capacity(answering(answer))).toEqual({ state: CapacityState.UNKNOWN })
  })
})
