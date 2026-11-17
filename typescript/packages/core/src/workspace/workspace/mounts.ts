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

import { mutationLock } from '../../cache/file/io.ts'
import type { FileCacheMixin } from '../../cache/file/mixin.ts'
import { normalizeIndexConfig, type IndexConfig } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { checkCommandLimits } from '../../policy/builtin/output_cap.ts'
import { BIN_PREFIX } from '../../shell/constants.ts'
import type { MachineTable } from '../../execution/machine/table.ts'
import { MountMode, VFSName, WritePolicy, type Limit, type ReadSpec } from '../../types.ts'
import { norm, normDir } from '../../utils/path.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import { HISTORY_PREFIX } from '../../vfs/history/history.ts'
import { LOCAL, LOCAL_PREFIXES } from '../../vfs/machine/constants.ts'
import { MachineVFS } from '../../vfs/machine/machine.ts'
import type { MountEntry } from '../mount/mount.ts'
import { checkReadCapability } from '../mount/read_policy.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { Mount } from '../mount/spec.ts'
import { checkWriteCapability, coerceWritePolicy } from '../mount/write_policy.ts'
import type { MountSpec } from './types.ts'

/** What the write verdict needs beyond the mounts themselves. */
export interface WriteDefaults {
  /** The mode a mount takes when it names none. */
  mode: MountMode
  /** The write policy a mount takes when it names none. */
  write: WritePolicy
  /** Whether the workspace's file cache keeps anything. */
  caching: boolean
}

/**
 * The mount table with each `"@local"` entry a machine mount over every
 * machine at that prefix, and, in a workspace with machines, `/tmp` and
 * `/dev/shm` so too unless a mount claims them. Mirrors Python's
 * `local_mounts`.
 *
 * @param mounts the constructor mapping.
 * @param machines whether the workspace has machines.
 * @throws an `"@local"` entry in a workspace without machines, or a string
 *   that is not `"@local"`.
 */
export function localMounts(
  mounts: Record<string, MountSpec | string>,
  machines: boolean,
): Record<string, MountSpec> {
  const table: Record<string, MountSpec> = {}
  for (const [prefix, value] of Object.entries(mounts)) {
    if (typeof value !== 'string') {
      table[prefix] = value
      continue
    }
    if (value !== LOCAL)
      throw new Error(
        `mount '${prefix}': '${value}' is not a VFS; the one string a mount takes is '${LOCAL}'`,
      )
    if (!machines) throw new Error(`mount '${prefix}': ${LOCAL} needs a workspace with machines`)
    table[prefix] = machineMount(norm(prefix))
  }
  if (machines) {
    const claimed = new Set(Object.keys(table).map((prefix) => norm(prefix)))
    for (const prefix of LOCAL_PREFIXES) {
      if (!claimed.has(prefix)) table[prefix] = machineMount(prefix)
    }
  }
  return table
}

/**
 * The machines' own files at `root`, recorded as the registry's `machine`
 * VFS, so a snapshot rebuilds the mount from its config. Mirrors Python's
 * `machine_mount`.
 *
 * @param root the path on each machine, the same as the prefix.
 */
export function machineMount(root: string): Mount {
  return new Mount(new MachineVFS({ root }), { vfsRef: VFSName.MACHINE })
}

/**
 * Hand every machine mount the workspace's machines. Mirrors Python's
 * `bind_machine_mounts`.
 *
 * @param mounts the workspace's mounts.
 * @param machines its machines.
 * @param fallback where a new name lands when a mount's config names no
 *   `defaultMachine`; null for a workspace without machines.
 * @throws a machine mount names a machine the workspace lacks, or the
 *   workspace has none.
 */
export function bindMachineMounts(
  mounts: Iterable<MountEntry>,
  machines: MachineTable,
  fallback: string | null,
): void {
  for (const entry of mounts) {
    if (!(entry.vfs instanceof MachineVFS)) continue
    if (fallback === null)
      throw new Error(`mount '${entry.prefix}': a machine mount needs a workspace with machines`)
    entry.vfs.bindMachines(machines, fallback)
  }
}

/**
 * The `mounts` mapping in resolved form: every accepted spelling
 * (bare VFS, `[VFS, mode]`, `[VFS, mode, commandLimits]`)
 * narrowed to three parallel maps. Mirrors the Python
 * `normalize_mounts` in `workspace/mounts.py`.
 */
export function normalizeMounts(
  mounts: Record<string, MountSpec>,
  defaultRead: ReadSpec,
  index?: IndexConfig,
  defaults: WriteDefaults = {
    mode: MountMode.READ,
    write: WritePolicy.UNCONDITIONAL,
    caching: true,
  },
) {
  const bare: Record<string, BaseVFS> = {}
  const modes: Record<string, MountMode> = {}
  const commandLimits: Record<string, Record<string, Limit>> = {}
  const refs: Record<string, string> = {}
  const indexes: Record<string, IndexConfig> = {}
  const read: Record<string, ReadSpec> = {}
  const write: Record<string, WritePolicy> = {}
  for (const [prefix, spec] of Object.entries(mounts)) {
    if (spec instanceof Mount) {
      bare[prefix] = spec.vfs
      if (spec.options.mode !== undefined) modes[prefix] = spec.options.mode
      if (spec.options.commandLimits !== undefined)
        commandLimits[prefix] = spec.options.commandLimits
      if (spec.options.vfsRef !== undefined && spec.options.vfsRef !== null) {
        refs[prefix] = spec.options.vfsRef
      }
      if (spec.options.index !== undefined)
        indexes[prefix] = normalizeIndexConfig(spec.options.index)
      if (spec.options.read !== undefined) read[prefix] = spec.options.read
      if (spec.options.write !== undefined) write[prefix] = coerceWritePolicy(spec.options.write)
    } else if (Array.isArray(spec)) {
      const [vfs, mode, mountCommandLimits] = spec as readonly [
        BaseVFS,
        MountMode,
        Record<string, Limit>?,
      ]
      bare[prefix] = vfs
      modes[prefix] = mode
      if (mountCommandLimits !== undefined) commandLimits[prefix] = mountCommandLimits
    } else {
      bare[prefix] = spec as BaseVFS
    }
  }
  for (const [prefix, table] of Object.entries(commandLimits)) {
    checkCommandLimits(table, `mount ${prefix}`, false)
  }
  // Every mount spelling converges here, which is why this is where a
  // read policy is checked against what its backend can honour: one
  // verdict per mount, whatever entry point declared it.
  for (const [prefix, vfs] of Object.entries(bare)) {
    checkReadCapability(prefix, vfs, read[prefix] ?? defaultRead, indexes[prefix] ?? index)
    checkWriteCapability(
      prefix,
      vfs,
      write[prefix] ?? defaults.write,
      modes[prefix] ?? defaults.mode,
      defaults.caching && vfs.cachesReads,
    )
  }
  return { bare, modes, commandLimits, refs, indexes, read, write }
}

/** Drop mount cache state atomically with deferred file-cache fills. */
async function clearMountCache(
  cache: FileCacheMixin | null,
  prefix: string,
  indices: readonly IndexCacheStore[],
): Promise<void> {
  const clearIndices = async (): Promise<void> => {
    for (const index of new Set(indices)) await index.invalidatePrefix(prefix.slice(0, -1))
  }
  if (cache === null) return clearIndices()
  await mutationLock(cache, async () => {
    await cache.remove(prefix.slice(0, -1) || '/', { subtree: true })
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
    entry.indexStore,
    ...previous.filter((m) => entry.prefix.startsWith(m.prefix)).map((m) => m.indexStore),
  ]
  entry.beforeUse = () => clearMountCache(registry.fileCache, entry.prefix, indices)
}

/**
 * Remove one mount, closing its owned VFS. The virtual root, the device
 * mount, and the history view are permanent. Mirrors the Python `unmount` in
 * `workspace/mounts.py`.
 */
export async function unmountPrefix(
  registry: MountRegistry,
  prefix: string,
  isShuttingDown: () => boolean,
  sharedMounts: Set<BaseVFS>,
): Promise<void> {
  const norm = normDir(prefix)
  if (norm === '/') {
    throw new Error(`cannot unmount root: ${prefix}`)
  }
  if (norm === '/dev/') {
    throw new Error(`cannot unmount reserved prefix: /dev/`)
  }
  if (norm === HISTORY_PREFIX + '/') {
    throw new Error(`cannot unmount history view: ${HISTORY_PREFIX}`)
  }
  if (norm === BIN_PREFIX + '/') {
    throw new Error(`cannot unmount program view: ${BIN_PREFIX}`)
  }
  const entry = registry.tryMountForPrefix(prefix, true)
  if (entry === null) throw new Error(`no mount at prefix: ${norm}`)
  if (entry.retiring) throw new Error(`mount is being unmounted: ${norm}`)
  entry.retiring = true
  try {
    await clearMountCache(registry.fileCache, norm, [entry.indexStore])
    if (isShuttingDown()) throw new Error('Workspace is closed')
    if (registry.tryMountForPrefix(prefix, true) !== entry) {
      throw new Error(`mount changed while unmounting: ${prefix}`)
    }
    registry.unmount(prefix)
  } catch (error) {
    entry.retiring = false
    throw error
  }
  const vfs = entry.vfs
  const closing = closeVfs(registry, entry, sharedMounts.has(vfs))
  registry.retiringMounts.set(vfs, closing)
  try {
    await closing
  } finally {
    registry.retiringMounts.delete(vfs)
  }
}

async function closeVfs(
  registry: MountRegistry,
  entry: MountEntry,
  shared: boolean,
): Promise<void> {
  const vfs = entry.vfs
  try {
    await entry.activity.wait()
    try {
      if (!shared) {
        registry.retiredMounts.add(vfs)
        await vfs.close()
      }
    } finally {
      await entry.indexStore.close()
    }
  } finally {
    registry.releaseClock(vfs)
  }
}
