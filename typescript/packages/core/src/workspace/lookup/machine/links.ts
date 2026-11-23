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

import { chosen, holders, newNameMachine } from '../../../core/machine/place.ts'
import type { Holder } from '../../../core/machine/types.ts'
import { folderOf } from '../../../core/machine/utils.ts'
import type { RemoteRuntime } from '../../../runtime/machine/runtime.ts'
import { norm, parent } from '../../../utils/path.ts'
import { MachineVFS } from '../../../vfs/machine/machine.ts'
import type { NamespaceReader } from '../../dispatcher/reader.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { SessionState } from '../../session/session.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { Consumer, type ExternalTarget } from '../types.ts'
import { machineMounts, onlyMachine, pathOnMount } from './mounts.ts'

/**
 * The machine an `ln` runs on whole, when one machine can make every link
 * (`linkingMachine`): the machine makes the link, so its programs follow it,
 * where Mirage's link table holds links only Mirage sees.
 *
 * It runs from the session's folder when the machine holds that folder.
 * From any other folder it runs from `/` when every path it names is
 * absolute, and stays with Mirage otherwise, since the machine could not
 * resolve a relative name. Mirrors Python's `link_machine`.
 *
 * @param made each link's absolute path and its target, resolved as the
 *   link will resolve it.
 * @param symbolic whether the links are symbolic.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param absolute whether every path the command names, that the folder it
 *   runs from could change, is typed absolute.
 */
export async function linkMachine(
  made: readonly (readonly [string, string])[],
  symbolic: boolean,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  absolute: boolean,
): Promise<ExternalTarget | null> {
  if (made.length === 0) return null
  const runtime = await linkingMachine(made, symbolic, session, registry, links)
  if (runtime === null || !(await runtime.handle().hasProgram('ln'))) return null
  const cwd = norm(session.cwd)
  if (cwd === '/' || (await holdsFolder(runtime, cwd, session, registry, links)))
    return { kind: Consumer.EXTERNAL, runtime }
  return absolute ? { kind: Consumer.EXTERNAL, runtime, cwd: '/' } : null
}

/**
 * Whether a machine holds a folder at its own path, so a program there can
 * run from it. Mirrors Python's `_holds_folder`.
 *
 * @param runtime the machine's runtime.
 * @param folder the folder, an absolute virtual path.
 * @param session the session.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 */
async function holdsFolder(
  runtime: RemoteRuntime,
  folder: string,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
): Promise<boolean> {
  const mounts = machineMounts([[folder, false]], session, registry, links)
  const entry = mounts?.[0]
  if (entry === undefined || !(entry.vfs instanceof MachineVFS)) return false
  const held = await holders(entry.vfs.accessor, pathOnMount(entry, folder))
  return held.some((one) => one.machine === runtime.defaultMachine && mayBeFolder(one))
}

/**
 * Whether a machine holds a folder at a name as far as is known: a mount on
 * one machine asks nothing, so its machine answers for itself. Mirrors
 * Python's `_may_be_folder`.
 *
 * @param one the machine and what it reports for the name.
 */
function mayBeFolder(one: Holder): boolean {
  return one.isFolder || one.entry === null
}

/**
 * The one machine that makes every link, when one can. A link is made on
 * the machine holding its target, the copy shown of it (`chosen`), so the
 * link leads where Mirage reads the target; a symbolic link to a name no
 * machine holds is a new name like any other (`newNameMachine`). That
 * machine must hold the link's folder, whose copy shown is a folder, and no
 * other machine may hold the link's name, which Mirage's own `ln` then
 * answers for.
 *
 * Null when a path is off a machine mount, the session's rules or a coded
 * file policy speak for the mount, a hard link's target is missing, or the
 * links land on different machines: the links are then Mirage's own.
 * Mirrors Python's `_linking_machine`.
 *
 * @param made each link's absolute path and its target, resolved as the
 *   link will resolve it.
 * @param symbolic whether the links are symbolic.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 */
async function linkingMachine(
  made: readonly (readonly [string, string])[],
  symbolic: boolean,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
): Promise<RemoteRuntime | null> {
  const scopes: [string, boolean][] = [
    ...made.map(([link]): [string, boolean] => [parent(link), true]),
    ...made.map(([, target]): [string, boolean] => [target, false]),
  ]
  const mounts = machineMounts(scopes, session, registry, links)
  if (mounts === null || (await registry.policies.wantsFor('preVfs', session.sessionId)))
    return null
  const machines = new Set<string>()
  for (const [at, [link, target]] of made.entries()) {
    const folder = mounts[at]
    const aimed = mounts[made.length + at]
    if (folder === undefined || !(folder.vfs instanceof MachineVFS)) return null
    if (aimed === undefined || !(aimed.vfs instanceof MachineVFS)) return null
    const spec = pathOnMount(folder, link)
    const held = await holders(aimed.vfs.accessor, pathOnMount(aimed, target))
    let machine: string
    if (held.length > 0) {
      machine = chosen(aimed.vfs.accessor, held).machine
    } else if (symbolic) {
      try {
        machine = await newNameMachine(folder.vfs.accessor, spec)
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOTDIR') throw error
        console.debug(`${link}: its folder is a file:`, error)
        return null
      }
    } else {
      return null
    }
    const above = await holders(folder.vfs.accessor, folderOf(spec))
    if (above.length === 0 || !mayBeFolder(chosen(folder.vfs.accessor, above))) return null
    if (!above.some((one) => one.machine === machine && mayBeFolder(one))) return null
    if (
      above.length > 1 &&
      (await holders(folder.vfs.accessor, spec)).some((one) => one.machine !== machine)
    )
      return null
    machines.add(machine)
  }
  return onlyMachine([...machines].sort(compareCodePoints), registry)
}
