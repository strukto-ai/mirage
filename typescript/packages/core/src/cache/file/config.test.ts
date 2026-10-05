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
import { errorSummary } from '../../secrets/summary.ts'
import { type CacheConfig, CacheType, normalizeCacheConfig } from './config.ts'

describe('normalizeCacheConfig', () => {
  it.each([
    [
      { limit: '1MB', max_drain_bytes: 64 },
      { limit: '1MB', maxDrainBytes: 64 },
    ],
    [
      { type: CacheType.REDIS, limit: '8GB', url: 'redis://localhost:6379/0', key_prefix: 'w1:' },
      { type: CacheType.REDIS, limit: '8GB', url: 'redis://localhost:6379/0', keyPrefix: 'w1:' },
    ],
    // Any other type takes the redis fields, which its registered factory receives.
    [
      { type: 'probe', url: 'redis://x' },
      { type: 'probe', url: 'redis://x' },
    ],
  ])('takes %j', (config, expected) => {
    expect(normalizeCacheConfig(config as CacheConfig)).toEqual(expected)
  })

  it.each([
    [{ limti: '1MB' }, 'limti: unrecognized_keys'],
    [{ url: 'redis://localhost:6379/0' }, 'url: unrecognized_keys'],
    [{ type: CacheType.RAM, url: 'redis://localhost:6379/0' }, 'url: unrecognized_keys'],
    [{ type: CacheType.REDIS, key_prefx: 'w1:' }, 'key_prefx: unrecognized_keys'],
    [{ maxDrainBytes: 1, max_drain_bytes: 2 }, 'maxDrainBytes: unrecognized_keys'],
    [{ type: null }, 'type: custom'],
    [{ limit: {} }, 'limit: invalid_union'],
    [{ max_drain_bytes: '64' }, 'maxDrainBytes: invalid_type'],
    [{ type: CacheType.REDIS, url: 6379 }, 'url: invalid_type'],
  ])('refuses %j', (config, summary) => {
    expect(refusal(() => normalizeCacheConfig(config as unknown as CacheConfig))).toBe(summary)
  })
})

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (err) {
    if (err instanceof ZodError) return errorSummary(err)
    throw err
  }
  throw new Error('expected a refusal')
}
