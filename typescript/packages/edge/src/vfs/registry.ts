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
} from '@struktoai/mirage-core/vfs/registry'
import '../xml.ts'

/**
 * Every name an edge host builds: core's backends, whatever `registerVfs`
 * added there, and the ones core wires for a host that holds their
 * credential (`DIRECT_REGISTRY`), since a server-side isolate does.
 */
export function knownVfsNames(): string[] {
  return [...new Set([...knownCoreVfsNames(), ...Object.keys(DIRECT_REGISTRY)])].sort(
    compareCodePoints,
  )
}

/** Build a VFS by registry name, a direct backend first and core's table otherwise. */
export async function buildVfs(
  name: string,
  config: Record<string, unknown> = {},
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<BaseVFS> {
  if (name in DIRECT_REGISTRY) return buildVfsFrom(DIRECT_REGISTRY, {}, name, config, sources)
  return buildCoreVfs(name, config, sources)
}
