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

import type { ResolvedSource } from '@struktoai/mirage-core/secrets/types'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import {
  buildVfs as buildCoreVfs,
  buildVfsFrom,
  DIRECT_REGISTRY,
  knownVfsNames as knownCoreVfsNames,
  type VFSFactory,
} from '@struktoai/mirage-core/vfs/registry'
import { normalizeFields } from '@struktoai/mirage-core/utils/normalize'
import { refuseUnknownKeys } from '@struktoai/mirage-core/vfs/secrets'
import '../xml.ts'
import type { RedisVFSOptions } from './redis/redis.ts'

// The backends an edge host builds beyond core's, with the option names
// each takes: the ones node and python take, so one config serves all three.
const EDGE_REGISTRY: Record<string, VFSFactory> = {
  ...DIRECT_REGISTRY,
  redis: async (config) => {
    refuseUnknownKeys(config, ['url', 'keyPrefix', 'capacity'] satisfies (keyof RedisVFSOptions)[])
    const { RedisVFS } = await import('./redis/redis.ts')
    return new RedisVFS(normalizeFields(config))
  },
}

/**
 * Every name an edge host builds: core's backends, whatever `registerVfs`
 * added there, the ones core wires for a host that holds their credential
 * (`DIRECT_REGISTRY`), since a server-side isolate does, and redis over the
 * host's TCP API.
 */
export function knownVfsNames(): string[] {
  return [...new Set([...knownCoreVfsNames(), ...Object.keys(EDGE_REGISTRY)])].sort(
    compareCodePoints,
  )
}

/** Build a VFS by registry name, an edge backend first and core's table otherwise. */
export async function buildVfs(
  name: string,
  config: Record<string, unknown> = {},
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<BaseVFS> {
  if (name in EDGE_REGISTRY) return buildVfsFrom(EDGE_REGISTRY, {}, name, config, sources)
  // Core's refusal would list only its own table, leaving out the direct ones.
  const known = knownVfsNames()
  if (!known.includes(name)) {
    throw new Error(`unknown VFS ${JSON.stringify(name)}; known: ${known.join(', ')}`)
  }
  return buildCoreVfs(name, config, sources)
}
