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

import { normalizeFields } from '../../utils/normalize.ts'
import { refuseUnknownKeys } from '../../vfs/secrets.ts'

export const CacheType = Object.freeze({
  RAM: 'ram',
  REDIS: 'redis',
} as const)

export type CacheType = (typeof CacheType)[keyof typeof CacheType]

/**
 * Declarative description of the workspace's file cache, the twin of
 * {@link IndexConfig} for the byte cache. Mirrors Python `CacheConfig`.
 */
export interface CacheConfig {
  type?: CacheType
  limit?: string | number
  maxDrainBytes?: number | null
}

export interface RedisCacheConfig extends CacheConfig {
  url?: string
  keyPrefix?: string
}

const CACHE_FIELDS: Record<keyof CacheConfig, true> = {
  type: true,
  limit: true,
  maxDrainBytes: true,
}
const REDIS_CACHE_FIELDS: Record<keyof RedisCacheConfig, true> = {
  ...CACHE_FIELDS,
  url: true,
  keyPrefix: true,
}
const CacheTypeField = z.object({ type: z.string().optional() })

/**
 * Refuse a cache config's unknown keys and camelize the rest.
 *
 * The interface checks only a fresh literal, at compile time; python's
 * `CacheConfig` forbids extra fields at construction, and this is its
 * twin at the door that builds the cache. A key no field of its type
 * takes is refused; a field's snake_case spelling is taken at runtime and
 * written under its camelCase name, as `refuseUnknownKeys` and
 * `normalizeFields` do for a schemaless VFS block. Only the type and the
 * key names are checked: the values are the interface's to type. The
 * fields are picked by `type`, where python picks them by class: a RAM
 * cache takes no connection fields, and any other type takes the redis
 * set, which is what its registered factory receives.
 *
 * @param config the cache config as the caller passed it.
 * @returns the config with every key in its camelCase spelling.
 */
export function normalizeCacheConfig(config: CacheConfig): CacheConfig {
  const ram = (CacheTypeField.parse(config).type ?? CacheType.RAM) === CacheType.RAM
  const input = { ...config }
  refuseUnknownKeys(input, Object.keys(ram ? CACHE_FIELDS : REDIS_CACHE_FIELDS))
  return normalizeFields(input) as CacheConfig
}
