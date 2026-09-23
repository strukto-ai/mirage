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

import { HISTORY_PREFIX } from '../../vfs/history/history.ts'
import type { OpsRegistry } from '../../ops/registry.ts'
import type { VFS } from '../../vfs/base.ts'
import type { Limit, MountMode, ReadSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { MountSpec } from './types.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FileCache } from '../../cache/file/mixin.ts'
import { withCacheMutation } from '../../cache/file/io.ts'
import { checkReadCapability } from '../mount/read_policy.ts'
import { Mount } from '../mount/spec.ts'

/**
 * The `mounts` mapping in resolved form: every accepted spelling
 * (bare VFS, `[VFS, mode]`, `[VFS, mode, commandLimits]`)
 * narrowed to three parallel maps. Mirrors the Python
 * `normalize_mounts` in `workspace/mounts.py`.
 */
export interface NormalizedMounts {
  bare: Record<string, VFS>
  modes: Record<string, MountMode>
  commandLimits: Record<string, Record<string, Limit>>
  read: Record<string, ReadSpec>
}

export function normalizeMounts(
  mounts: Record<string, MountSpec>,
  defaultRead: ReadSpec,
): NormalizedMounts {
  const bare: Record<string, VFS> = {}
  const modes: Record<string, MountMode> = {}
  const commandLimits: Record<string, Record<string, Limit>> = {}
  const read: Record<string, ReadSpec> = {}
  for (const [prefix, spec] of Object.entries(mounts)) {
    if (Array.isArray(spec)) {
      const [vfs, mode, mountCommandLimits] = spec as readonly [
        VFS,
        MountMode,
        Record<string, Limit>?,
      ]
      bare[prefix] = vfs
      modes[prefix] = mode
      if (mountCommandLimits !== undefined) commandLimits[prefix] = mountCommandLimits
    } else if (spec instanceof Mount) {
      bare[prefix] = spec.vfs
      if (spec.options.mode !== undefined) modes[prefix] = spec.options.mode
      // Node's own unwrap used to lift this; core owns it now that a
      // Mount reaches here directly.
      if (spec.options.commandLimits !== undefined) {
        commandLimits[prefix] = spec.options.commandLimits
      }
      if (spec.options.read !== undefined) read[prefix] = spec.options.read
    } else {
      bare[prefix] = spec as VFS
    }
  }
  // Every mount spelling converges here, which is why this is where a
  // read policy is checked against what its backend can honour: one
  // verdict per mount, whatever door declared it.
  for (const [prefix, vfs] of Object.entries(bare)) {
    checkReadCapability(prefix, vfs, read[prefix] ?? defaultRead)
  }
  return { bare, modes, commandLimits, read }
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
    entry.vfs.index,
    ...previous.filter((m) => entry.prefix.startsWith(m.prefix)).map((m) => m.vfs.index),
  ].filter((index): index is IndexCacheStore => index !== undefined)
  entry.beforeUse = () => clearMountCache(registry.fileCache, entry.prefix, indices)
}

export interface UnmountDeps {
  registry: MountRegistry
  opsRegistry: OpsRegistry
  opened: Set<VFS>
  openOrder: VFS[]
  sharedMounts: Set<VFS>
  isShuttingDown: () => boolean
}

/**
 * Remove one mount, closing its owned VFS when its last alias leaves. Operations are shared by kind,
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
      entry.vfs.index === undefined ? [] : [entry.vfs.index],
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
  const vfs = entry.vfs
  const remaining = deps.registry.allMounts()
  const stillMounted = remaining.some((m) => m.vfs === vfs)
  const kindStillMounted = remaining.some((m) => m.vfs.kind === vfs.kind)
  deps.opsRegistry.unregisterVfs(kindStillMounted ? vfs : vfs.kind)
  for (const survivor of remaining) {
    if (survivor.vfs.kind === vfs.kind) {
      deps.opsRegistry.registerVfs(survivor.vfs, false)
    }
  }
  if (!stillMounted) {
    const closing = closeVfs(deps, entry)
    deps.registry.retiringMounts.set(vfs, closing)
    try {
      await closing
    } finally {
      deps.registry.retiringMounts.delete(vfs)
    }
  }
}

async function closeVfs(deps: UnmountDeps, entry: MountEntry): Promise<void> {
  const vfs = entry.vfs
  const shared = deps.sharedMounts.has(vfs)
  if (!shared) await entry.activity.wait()
  const idx = deps.openOrder.indexOf(vfs)
  if (idx !== -1) deps.openOrder.splice(idx, 1)
  deps.opened.delete(vfs)
  if (shared) return
  deps.registry.retiredMounts.add(vfs)
  await vfs.close()
}
