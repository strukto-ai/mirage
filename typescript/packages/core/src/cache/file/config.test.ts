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
import { ZodError } from 'zod'
import { type CacheConfig, CacheType, normalizeCacheConfig } from './config.ts'

describe('normalizeCacheConfig', () => {
  it('takes the fields of a RAM cache', () => {
    expect(normalizeCacheConfig({ limit: '1MB', maxDrainBytes: 64 })).toEqual({
      limit: '1MB',
      maxDrainBytes: 64,
    })
  })

  it('takes the fields of a redis cache', () => {
    const config = {
      type: CacheType.REDIS,
      limit: '8GB',
      url: 'redis://localhost:6379/0',
      keyPrefix: 'w1:',
    } as CacheConfig
    expect(normalizeCacheConfig(config)).toEqual(config)
  })

  it('gives any non-RAM cache type the redis fields', () => {
    const config = { type: 'probe' as CacheType, url: 'redis://x', keyPrefix: 'p:' } as CacheConfig
    expect(normalizeCacheConfig(config)).toEqual(config)
  })

  it('refuses an unknown field on a redis cache', () => {
    expect(() =>
      normalizeCacheConfig({ type: CacheType.REDIS, key_prefx: 'w1:' } as CacheConfig),
    ).toThrow(/"key_prefx"/)
  })

  it('refuses a redis field on an explicit RAM cache', () => {
    expect(() =>
      normalizeCacheConfig({ type: CacheType.RAM, url: 'redis://localhost:6379/0' } as CacheConfig),
    ).toThrow(/"url"/)
  })

  it('refuses an unknown field', () => {
    expect(() => {
      normalizeCacheConfig({ limti: '1MB' } as CacheConfig)
    }).toThrow(/"limti"/)
  })

  it('refuses a redis field on a default RAM cache', () => {
    expect(() => {
      normalizeCacheConfig({ url: 'redis://localhost:6379/0' } as CacheConfig)
    }).toThrow(/"url"/)
  })

  it('writes a snake_case field under its camelCase name', () => {
    expect(normalizeCacheConfig({ max_drain_bytes: 64 } as CacheConfig)).toEqual({
      maxDrainBytes: 64,
    })
  })

  it('refuses a null cache type rather than building RAM', () => {
    expect(() => normalizeCacheConfig({ type: null } as unknown as CacheConfig)).toThrow(ZodError)
  })
})
