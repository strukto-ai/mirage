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

import { z } from 'zod'

import { parseConfigWithSchema, refuseRepeatedFields, type ConfigOf } from '../../vfs/secrets.ts'

export const CacheType = Object.freeze({
  RAM: 'ram',
  REDIS: 'redis',
} as const)

export type CacheType = (typeof CacheType)[keyof typeof CacheType]

// The type is any registered one: `registerFileCacheStore` takes names
// this module does not list, and the registry names a missing factory.
const CacheConfigSchema = z.object({
  type: z.custom<CacheType>((value) => typeof value === 'string').optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  maxDrainBytes: z.number().nullable().optional(),
})

const RedisCacheConfigSchema = CacheConfigSchema.extend({
  url: z.string().optional(),
  keyPrefix: z.string().optional(),
})

/**
 * Declarative description of the workspace's file cache, the twin of
 * {@link IndexConfig} for the byte cache. Mirrors Python `CacheConfig`.
 */
export type CacheConfig = ConfigOf<typeof CacheConfigSchema>

export type RedisCacheConfig = ConfigOf<typeof RedisCacheConfigSchema>

/**
 * Check a cache config the way python's `CacheConfig` checks one on
 * construction, and camelize its keys.
 *
 * The fields are picked by `type`, where python picks them by class: a
 * RAM cache takes no connection fields, and any other type takes the
 * redis set its registered factory receives. One field named in both
 * spellings is refused, as python refuses the camelCase one.
 *
 * @param config the cache config as the caller passed it.
 * @returns the checked config with every key in its camelCase spelling.
 */
export function normalizeCacheConfig(config: CacheConfig): CacheConfig {
  const input = config as Record<string, unknown>
  refuseRepeatedFields(input)
  return (input.type ?? CacheType.RAM) === CacheType.RAM
    ? parseConfigWithSchema(CacheConfigSchema, input)
    : parseConfigWithSchema(RedisCacheConfigSchema, input)
}
