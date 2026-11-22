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

import { holders } from '../../../core/machine/place.ts'
import type { ByteSource } from '../../../io/types.ts'
import { restrictedMountsFor } from '../../../runtime/binding.ts'
import { RemoteRuntime } from '../../../runtime/machine/runtime.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { CycleError, norm } from '../../../utils/path.ts'
import { BinViewVFS } from '../../../vfs/bin/bin.ts'
import { MachineVFS } from '../../../vfs/machine/machine.ts'
import type { NamespaceReader } from '../../dispatcher/reader.ts'
import type { MountEntry } from '../../mount/mount.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { SessionState } from '../../session/session.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { compareCodePoints } from '../../../utils/sort.ts'

/**
 * The machine mount showing `path` at the same path on its machines, with no
 * other mount and no link of Mirage's own under the path; null for any other
 * path, for one a write may not reach, and for one that walks through a link
 * of Mirage's own, which the machine does not have. A name the `/usr/bin`
 * view leaves to the mount beneath it is read from that mount, so
 * `/usr/bin/python3` is the machine's own file where the machine's disk lies
 * under the view.
 *
 * The link table is walked last: a path that is no machine's needs no look
 * at it, and a folder of many links costs a walk of them all.
 */
export function machineMount(
  registry: MountRegistry,
  links: NamespaceReader,
  path: string,
  writes: boolean,
): MountEntry | null {
  let entry = registry.tryMountFor(path)
  if (
    entry !== null &&
    !writes &&
    entry.vfs instanceof BinViewVFS &&
    entry.vfs.leaves(mountKey(path, entry.prefix))
  )
    entry = registry.mountBeneath(entry, path)
  if (entry === null || !(entry.vfs instanceof MachineVFS)) return null
  if (norm(entry.vfs.config.root ?? '/') !== norm(entry.prefix)) return null
  if (writes && entry.mode === MountMode.READ) return null
  const below = `${rstripSlash(norm(path))}/`
  if (registry.allMounts().some((m) => m !== entry && norm(m.prefix).startsWith(below))) return null
  try {
    if (
      norm(links.follow(norm(path))) !== norm(path) ||
      links.linkStatsBelow(norm(path)).length > 0
    )
      return null
  } catch (err) {
    if (!(err instanceof CycleError)) throw err
    console.debug(`${path}: a link loop keeps it here: ${String(err)}`)
    return null
  }
  return entry
}

/**
 * Whether anything is piped in: the empty input `xargs` gives a command, as
 * GNU's gives it `/dev/null`, is none. Mirrors Python's `is_piped`.
 */
export function isPiped(stdin: ByteSource | null): boolean {
  return stdin !== null && !(stdin instanceof Uint8Array && stdin.byteLength === 0)
}

function rulesRestrict(
  session: SessionState,
  registry: MountRegistry,
  entries: MountEntry[],
): boolean {
  const prefixes = registry.allMounts().map((m) => m.prefix)
  const restricted = new Set(restrictedMountsFor(session, prefixes).map((p) => norm(p)))
  return entries.some((e) => restricted.has(norm(e.prefix)))
}

/**
 * The machine mount showing each path at its own path, in order; null when
 * there is no path, any path is elsewhere, or the session's rules restrict
 * one of those mounts. Mirrors Python's `machine_mounts`.
 *
 * @param scopes each absolute path, with whether the command may write it.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 */
export function machineMounts(
  scopes: readonly (readonly [string, boolean])[],
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
): MountEntry[] | null {
  const mounts: MountEntry[] = []
  for (const [path, writes] of scopes) {
    const entry = machineMount(registry, links, path, writes)
    if (entry === null) return null
    mounts.push(entry)
  }
  if (scopes.length === 0 || rulesRestrict(session, registry, mounts)) return null
  return mounts
}

/**
 * The runtime that runs programs on the one machine named; null for none or
 * several. Mirrors Python's `only_machine`.
 *
 * @param machines the candidate machines.
 * @param registry the workspace's mounts and machines.
 */
export function onlyMachine(
  machines: readonly string[],
  registry: MountRegistry,
): RemoteRuntime | null {
  if (machines.length !== 1) return null
  return (
    registry.runtimeEntries.find(
      (e): e is RemoteRuntime => e instanceof RemoteRuntime && e.defaultMachine === machines[0],
    ) ?? null
  )
}

/**
 * The machines a machine mount shows, by its config: the ones it names, else
 * every machine the workspace runs programs on. Mirrors Python's
 * `mount_machines`.
 *
 * @param entry a machine mount.
 * @param registry the workspace's mounts and machines.
 */
export function mountMachines(entry: MountEntry, registry: MountRegistry): string[] {
  const named = entry.vfs instanceof MachineVFS ? entry.vfs.config.machines : null
  if (named !== null && named !== undefined) return [...named]
  return [
    ...new Set(
      registry.runtimeEntries
        .filter((e): e is RemoteRuntime => e instanceof RemoteRuntime)
        .map((e) => e.defaultMachine),
    ),
  ].sort(compareCodePoints)
}

/**
 * The one machine holding every path, each its own at the same path on a
 * machine mount the session may use, and the folder it runs from; null when
 * any path is elsewhere, no one machine holds them all, or input is piped
 * into a machine that takes none. A name several machines hold is no one
 * machine's to answer for: Mirage shows it as one (`chosen`), so the command
 * stays with Mirage. The folder a command only runs from may be on several.
 * Mirrors Python's `machine_holding_all`.
 *
 * @param scopes each absolute path, with whether the command may write it.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param stdin what is piped into it.
 * @param folder the folder it runs from, which the machine must hold too;
 *   null for one that runs from `/`.
 */
export async function machineHoldingAll(
  scopes: readonly (readonly [string, boolean])[],
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  stdin: ByteSource | null,
  folder: string | null = null,
): Promise<RemoteRuntime | null> {
  const stood: (readonly [string, boolean])[] = folder === null ? [] : [[folder, false]]
  const every = [...scopes, ...stood]
  const mounts = machineMounts(every, session, registry, links)
  if (mounts === null) return null
  if (await registry.policies.wantsFor('preVfs', session.sessionId)) return null
  let candidates: string[] | null = null
  for (const [at, [path]] of every.entries()) {
    const entry = mounts[at]
    if (entry === undefined || !(entry.vfs instanceof MachineVFS)) return null
    const held = (await holders(entry.vfs.accessor, pathOnMount(entry, path))).map(
      (one) => one.machine,
    )
    if (held.length > 1 && at < scopes.length) return null
    candidates = candidates === null ? held : candidates.filter((m) => held.includes(m))
  }
  const runtime = onlyMachine(candidates ?? [], registry)
  if (runtime === null) return null
  if (isPiped(stdin) && !runtime.handle().takesInput) return null
  return runtime
}

/**
 * The machines whose own files a folder is, by the mount showing it
 * (`/srv/gpu` over the gpu machine, `/tmp` over every machine); none for a
 * folder in a store. Mirrors Python's `folder_machines`.
 *
 * @param folder the folder, an absolute virtual path.
 * @param registry the workspace's mounts and machines.
 */
export function folderMachines(folder: string, registry: MountRegistry): string[] {
  const entry = registry.tryMountFor(folder)
  if (entry === null || !(entry.vfs instanceof MachineVFS)) return []
  return mountMachines(entry, registry)
}

/**
 * Whether the workspace runs programs on more than one machine, the only
 * case where which machine a command runs on decides where a new file
 * lands. Mirrors Python's `several_machines`.
 *
 * @param registry the workspace's mounts and machines.
 */
export function severalMachines(registry: MountRegistry): boolean {
  const machines = new Set(
    registry.runtimeEntries
      .filter((e): e is RemoteRuntime => e instanceof RemoteRuntime)
      .map((e) => e.defaultMachine),
  )
  return machines.size > 1
}

/**
 * A virtual path as its mount addresses it, the mount's own root included.
 * Mirrors Python's `path_on_mount`.
 *
 * @param entry the mount showing the path.
 * @param path an absolute virtual path on it.
 */
export function pathOnMount(entry: MountEntry, path: string): PathSpec {
  return PathSpec.fromStrPath(path, mountKey(path, rstripSlash(entry.prefix)))
}
