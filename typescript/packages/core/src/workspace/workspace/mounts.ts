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

import { HISTORY_PREFIX } from '../../resource/history/history.ts'
import type { OpsRegistry } from '../../ops/registry.ts'
import type { Resource } from '../../resource/base.ts'
import type { Limit, MountMode } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { MountSpec } from './types.ts'

/**
 * The `resources` mapping in resolved form: every accepted spelling
 * (bare resource, `[resource, mode]`, `[resource, mode, commandLimits]`)
 * narrowed to three parallel maps. Mirrors the Python
 * `normalize_resources` in `workspace/mounts.py`.
 */
export interface NormalizedResources {
  bare: Record<string, Resource>
  modes: Record<string, MountMode>
  commandLimits: Record<string, Record<string, Limit>>
}

export function normalizeResources(resources: Record<string, MountSpec>): NormalizedResources {
  const bare: Record<string, Resource> = {}
  const modes: Record<string, MountMode> = {}
  const commandLimits: Record<string, Record<string, Limit>> = {}
  for (const [prefix, spec] of Object.entries(resources)) {
    if (Array.isArray(spec)) {
      const [resource, mode, mountCommandLimits] = spec as readonly [
        Resource,
        MountMode,
        Record<string, Limit>?,
      ]
      bare[prefix] = resource
      modes[prefix] = mode
      if (mountCommandLimits !== undefined) commandLimits[prefix] = mountCommandLimits
    } else {
      bare[prefix] = spec as Resource
    }
  }
  return { bare, modes, commandLimits }
}

export interface UnmountDeps {
  registry: MountRegistry
  opsRegistry: OpsRegistry
  opened: Set<Resource>
  openOrder: Resource[]
}

/**
 * Remove one mount and its cached scope, closing its resource if the
 * workspace had opened it and no other mount still references it. The
 * virtual root, the device mount, and the history view are permanent.
 * Mirrors the Python `unmount` in `workspace/mounts.py`.
 */
export async function unmountPrefix(deps: UnmountDeps, prefix: string): Promise<void> {
  const stripped = stripSlash(prefix)
  const norm = stripped ? `/${stripped}/` : '/'
  if (norm === '/') {
    throw new Error(`cannot unmount root: ${prefix}`)
  }
  if (norm === '/dev/') {
    throw new Error(`cannot unmount reserved prefix: /dev/`)
  }
  if (norm === HISTORY_PREFIX + '/') {
    throw new Error(`cannot unmount history view: ${HISTORY_PREFIX}`)
  }
  const mounted = deps.registry.tryMountForPrefix(prefix)
  if (mounted === null) {
    deps.registry.unmount(prefix)
    return
  }
  await mounted.cacheManager?.dropPrefix()
  const removed = deps.registry.unmount(prefix)
  const resource = removed.resource
  const stillMounted = deps.registry.allMounts().some((m) => m.resource === resource)
  if (!stillMounted) {
    deps.opsRegistry.unregisterResource(resource.kind)
    const idx = deps.openOrder.indexOf(resource)
    if (idx !== -1) deps.openOrder.splice(idx, 1)
    if (deps.opened.has(resource)) {
      deps.opened.delete(resource)
      await resource.close()
    }
  }
}
