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
import type { MountEntry } from '../mount/mount.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FileCache } from '../../cache/file/mixin.ts'
import { withCacheMutation } from '../../cache/file/io.ts'

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

/** Drop mount cache state atomically with deferred file-cache fills. */
async function clearMountCache(
  cache: FileCache | null,
  prefix: string,
  indices: readonly IndexCacheStore[],
): Promise<void> {
  const clearIndices = async (): Promise<void> => {
    for (const index of new Set(indices)) await index.invalidatePrefix(prefix.slice(0, -1))
  }
  if (cache === null) return clearIndices()
  await withCacheMutation(cache, async () => {
    await cache.remove(prefix.slice(0, -1))
    await cache.evictPrefix(prefix)
    await clearIndices()
  })
}

/** Keep synchronous registration; I/O awaits removal of shadowed state. */
export function prepareAddedMount(
  registry: MountRegistry,
  entry: MountEntry,
  previous: readonly MountEntry[],
): void {
  const indices = [
    entry.resource.index,
    ...previous.filter((m) => entry.prefix.startsWith(m.prefix)).map((m) => m.resource.index),
  ].filter((index): index is IndexCacheStore => index !== undefined)
  entry.beforeUse = () => clearMountCache(registry.fileCache, entry.prefix, indices)
}

export interface UnmountDeps {
  registry: MountRegistry
  opsRegistry: OpsRegistry
  opened: Set<Resource>
  openOrder: Resource[]
  sharedResources: Set<Resource>
  isShuttingDown: () => boolean
}

/**
 * Remove one mount, closing its owned resource when its last alias leaves. Operations are shared by kind,
 * so they remain registered while any mount uses that kind. The virtual
 * root, the device mount, and the history view are permanent. Mirrors the
 * Python `unmount` in `workspace/mounts.py`.
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
  const entry = deps.registry.tryMountForPrefix(prefix)
  if (entry === null) throw new Error(`no mount at prefix: ${norm}`)
  if (entry.retiring) throw new Error(`mount is being unmounted: ${norm}`)
  entry.retiring = true
  try {
    await clearMountCache(
      deps.registry.fileCache,
      norm,
      entry.resource.index === undefined ? [] : [entry.resource.index],
    )
    if (deps.isShuttingDown()) throw new Error('Workspace is closed')
    if (deps.registry.tryMountForPrefix(prefix) !== entry) {
      throw new Error(`mount changed while unmounting: ${prefix}`)
    }
    deps.registry.unmount(prefix)
  } catch (error) {
    entry.retiring = false
    throw error
  }
  const resource = entry.resource
  const remaining = deps.registry.allMounts()
  const stillMounted = remaining.some((m) => m.resource === resource)
  const kindStillMounted = remaining.some((m) => m.resource.kind === resource.kind)
  deps.opsRegistry.unregisterResource(kindStillMounted ? resource : resource.kind)
  for (const survivor of remaining) {
    if (survivor.resource.kind === resource.kind) {
      deps.opsRegistry.registerResource(survivor.resource, false)
    }
  }
  if (!stillMounted) {
    const closing = closeResource(deps, entry)
    deps.registry.retiringResources.set(resource, closing)
    try {
      await closing
    } finally {
      deps.registry.retiringResources.delete(resource)
    }
  }
}

async function closeResource(deps: UnmountDeps, entry: MountEntry): Promise<void> {
  const resource = entry.resource
  const shared = deps.sharedResources.has(resource)
  if (!shared) await entry.activity.wait()
  const idx = deps.openOrder.indexOf(resource)
  if (idx !== -1) deps.openOrder.splice(idx, 1)
  deps.opened.delete(resource)
  if (shared) return
  deps.registry.retiredResources.add(resource)
  await resource.close()
}
