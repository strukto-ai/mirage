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

import type { MachineAccessor } from '../../accessor/machine.ts'
import { currentCaller, noteDecision } from '../../context/session_context.ts'
import { eacces, enoent, enotdir } from '../../errors/fs.ts'
import type { FsError } from '../../errors/types.ts'
import type { PathSpec } from '../../types.ts'
import { KERNEL_VIEWS } from './constants.ts'
import { hiddenMachines, statEntry } from './stat.ts'
import { Copies, Holder, Landing } from './types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { folderOf, machinePath } from './utils.ts'

/**
 * The machine the running command's program runs on, when it is one of the
 * mount's (`python gen.py > /tmp/out`); null for a command that runs no
 * program on one.
 *
 * @param accessor the mount's machines.
 */
export function runningMachine(accessor: MachineAccessor): string | null {
  const { machine } = currentCaller()
  if (machine === null || !accessor.names().includes(machine.name)) return null
  return machine.name
}

/**
 * Why bytes from one machine do not go to another, for the decision record
 * of the refusal (stderr says `Permission denied`).
 *
 * @param source the machine the bytes come from.
 * @param target the machine they would go to.
 */
export function crossingReason(source: string, target: string): string {
  return `machine ${source}'s bytes do not go to machine ${target}: copy them through a store`
}

/**
 * The refusal of bytes going from one machine to another: EACCES for the
 * file, the reason on the line's decision record.
 *
 * @param source the machine the bytes come from.
 * @param target the machine they would go to.
 * @param path the file the refusal names.
 */
export function crossingRefused(source: string, target: string, path: PathSpec): FsError {
  noteDecision({
    kind: 'deny',
    reason: crossingReason(source, target),
    policy: '',
    askId: null,
  })
  return eacces(path)
}

/**
 * Refuse bytes going from one machine to another through a program the line
 * runs on a machine: a file of `machine` it reads (`prog < /srv/b/in`),
 * or its output landing there (`prog > /srv/b/out`), when the program is
 * on another of the workspace's machines. Bytes go between a machine and a
 * store, never from one machine to another. The refusal is `Permission
 * denied`, its reason on the line's decision record.
 *
 * @param accessor the mount's machines.
 * @param machine the machine the op reads from or lands on.
 * @param path the file.
 * @param reads the program reads the file, whose bytes go from `machine`
 *   to it; else its bytes land on `machine`.
 * @throws FsError the program runs on another machine.
 */
export function refuseCrossing(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  reads = false,
): void {
  const caller = currentCaller()
  const running = caller.machine
  if (running !== null && running.name !== machine && accessor.isMachine(running.name)) {
    if (reads) throw crossingRefused(machine, running.name, path)
    throw crossingRefused(running.name, machine, path)
  }
  if (reads) return
  for (const source of [...(caller.copiedFrom ?? [])].sort(compareCodePoints)) {
    if (source !== machine && accessor.isMachine(source))
      throw crossingRefused(source, machine, path)
  }
}

/**
 * The machine whose file the copy being made by a read and a write read
 * (`Caller.copiedFrom`), when it read one machine's file and that machine is
 * one of the mount's; null for any other write. Mirrors Python's
 * `copy_machine`.
 *
 * @param accessor the mount's machines.
 */
export function copyMachine(accessor: MachineAccessor): string | null {
  const copied = currentCaller().copiedFrom
  if (copied?.size !== 1) return null
  const [machine] = copied
  return machine !== undefined && accessor.names().includes(machine) ? machine : null
}

/**
 * The machine a whole file's bytes come from, which the file lands on: the
 * running program's, for its `>` (`runningMachine`), or the source's of a
 * copy made by a read and a write (`copyMachine`); null for any other write.
 * Mirrors Python's `origin_machine`.
 *
 * @param accessor the mount's machines.
 */
export function originMachine(accessor: MachineAccessor): string | null {
  return runningMachine(accessor) ?? copyMachine(accessor)
}

/**
 * Note a machine whose file the copy being made by a read and a write reads
 * (`Caller.copiedFrom`); nothing outside such a copy. Mirrors Python's
 * `note_copy_source`.
 *
 * @param machine the machine holding the file read.
 */
export function noteCopySource(machine: string): void {
  currentCaller().copiedFrom?.add(machine)
}

/**
 * The machine the running command is about, when it is one of the mount's:
 * the one its program runs on, else the one a command Mirage runs itself
 * prefers (`Caller.preferredMachine`); null when nothing says.
 *
 * @param accessor the mount's machines.
 */
export function commandMachine(accessor: MachineAccessor): string | null {
  const running = runningMachine(accessor)
  if (running !== null) return running
  const preferred = currentCaller().preferredMachine
  return preferred !== null && accessor.names().includes(preferred) ? preferred : null
}

/**
 * The one machine a name answers for when it is a kernel's own view of its
 * machine (`/proc/cpuinfo`), which no rule merges: the machine the command
 * is about, else the mount's default. Null for any other name, and on a
 * mount that shows one machine.
 *
 * @param accessor the mount's machines.
 * @param path the name, or a folder above it.
 * @param below the name's path under `path`, as a listing of the folder
 *   gives it; empty for `path` itself.
 */
export function kernelViewMachine(
  accessor: MachineAccessor,
  path: PathSpec,
  below = '',
): string | null {
  if (!accessor.several) return null
  const base = machinePath(accessor, path)
  const real = below === '' ? base : `${rstripSlash(base)}/${below}`
  if (!KERNEL_VIEWS.some((at) => real === at || real.startsWith(`${at}/`))) return null
  return commandMachine(accessor) ?? accessor.defaultMachine
}

/**
 * The machines asked about a name, in the order `machines:` lists them:
 * every machine of the mount, less each whose own links lead the name to
 * one the session hides, and for a kernel's view of its machine only the
 * one it answers for (`kernelViewMachine`).
 *
 * @param accessor the mount's machines.
 * @param path the name.
 */
export async function askedMachines(accessor: MachineAccessor, path: PathSpec): Promise<string[]> {
  const hidden = await hiddenMachines(accessor, path)
  const own = kernelViewMachine(accessor, path)
  return accessor.names().filter((name) => !hidden.includes(name) && (own === null || own === name))
}

/**
 * The machines that hold a name, each with its entry there, asked in
 * parallel (`asked_machines`); a mount on one machine asks nothing and lets the op
 * itself report a missing name.
 *
 * @param accessor the mount's machines.
 * @param path the name.
 */
export async function holders(accessor: MachineAccessor, path: PathSpec): Promise<Holder[]> {
  const names = await askedMachines(accessor, path)
  if (!accessor.several) return names.map((machine) => new Holder(machine))
  const found = await Promise.allSettled(names.map((m) => statEntry(accessor, m, path)))
  const held: Holder[] = []
  for (const [at, result] of found.entries()) {
    if (result.status === 'fulfilled') {
      held.push(new Holder(names[at] ?? '', result.value))
      continue
    }
    const code = (result.reason as { code?: unknown } | null)?.code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw result.reason
  }
  return held
}

/**
 * The one of several machines holding a name that every look at it goes
 * to: the copy written last, as one machine would hold it, by the times the
 * machines report. Copies written at the same time go to the machine the
 * command is about, else to the first `machines:` lists.
 *
 * @param accessor the mount's machines.
 * @param held the machines holding the name, at least one.
 */
export function chosen(accessor: MachineAccessor, held: Holder[]): Holder {
  const [first] = held
  if (first === undefined) throw new Error('machine: no machine holds the name')
  if (held.length === 1) return first
  const last = Math.max(...held.map((one) => one.writtenMs))
  const latest = held.filter((one) => one.writtenMs === last)
  const about = commandMachine(accessor)
  return latest.find((one) => one.machine === about) ?? latest[0] ?? first
}

/**
 * The machine a read of an existing name, or a change to it, goes to
 * (`chosen`).
 *
 * @param accessor the mount's machines.
 * @param path the name.
 * @throws ENOENT when no machine holds it.
 */
export async function holdingMachine(accessor: MachineAccessor, path: PathSpec): Promise<string> {
  return (await existingCopies(accessor, path)).shown.machine
}

/**
 * Every machine's copy of a name that must exist, each of which a removal or
 * a rename reaches, and the one shown (`chosen`). Mirrors Python's
 * `existing_copies`.
 *
 * @param accessor the mount's machines.
 * @param path the name.
 * @throws ENOENT when no machine holds it.
 */
export async function existingCopies(accessor: MachineAccessor, path: PathSpec): Promise<Copies> {
  const held = await holders(accessor, path)
  if (held.length === 0) throw enoent(path)
  return new Copies(held, chosen(accessor, held))
}

/**
 * Refuse a name a machine's own links lead to one the session hides, before
 * a program of the machine's writes through them.
 *
 * @param accessor the mount's machines.
 * @param machine the machine the write runs on.
 * @param path the name written.
 * @throws ENOENT when the name leads to a hidden one there.
 */
export async function refuseHidden(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
): Promise<void> {
  if ((await hiddenMachines(accessor, path)).includes(machine)) throw enoent(path)
}

/**
 * The machines holding a folder as a folder, for a name made in it. Mirrors
 * Python's `_folder_copies`.
 *
 * @param accessor the mount's machines.
 * @param folder the folder.
 * @param path the name made in it, which a refusal names.
 * @throws ENOTDIR when the copy shown of the folder is a file, whatever an
 *   older folder on another machine is.
 */
async function folderCopies(
  accessor: MachineAccessor,
  folder: PathSpec,
  path: PathSpec,
): Promise<Holder[]> {
  const held = await holders(accessor, folder)
  if (held.length > 0 && !chosen(accessor, held).isFolder) throw enotdir(path)
  return held.filter((one) => one.isFolder)
}

/**
 * The machines a new name lands on that must make its folder first, since
 * only other machines hold it; none where no machine holds the folder,
 * whose lack the op reports.
 *
 * @param accessor the mount's machines.
 * @param machines the machines the name lands on.
 * @param path the new name.
 * @throws ENOTDIR when the copy shown of the folder is a file, whatever an
 *   older folder on another machine is.
 */
export async function machinesLackingFolder(
  accessor: MachineAccessor,
  machines: string[],
  path: PathSpec,
): Promise<string[]> {
  if (!accessor.several) return []
  const folders = (await folderCopies(accessor, folderOf(path), path)).map((one) => one.machine)
  return machines.filter((m) => folders.length > 0 && !folders.includes(m))
}

/**
 * Whether a new name landing on a machine must make its folder there first
 * (`machinesLackingFolder`). Mirrors Python's `_lacks_folder`.
 *
 * @param accessor the mount's machines.
 * @param machine the machine the name lands on.
 * @param path the new name.
 * @throws ENOTDIR when the copy shown of the folder is a file.
 */
async function lacksFolder(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
): Promise<boolean> {
  return (await machinesLackingFolder(accessor, [machine], path)).length > 0
}

/**
 * The machine a new name lands on: the one the command is about, else the
 * mount's default, when it holds the name's folder or no machine does; else
 * the machine that holds the folder (`chosen`), so a name made in a folder
 * is listed with the folder's other names. A mount on one machine asks
 * nothing: the name lands there.
 *
 * @param accessor the mount's machines.
 * @param path the new name.
 * @param parents the folders above are made too (`mkdir -p`), so the
 *   folder is the nearest one above that any machine holds.
 * @throws ENOTDIR when the copy shown of the folder is a file, whatever an
 *   older copy on another machine is.
 */
export async function newNameMachine(
  accessor: MachineAccessor,
  path: PathSpec,
  parents = false,
): Promise<string> {
  const about = commandMachine(accessor) ?? accessor.defaultMachine
  if (!accessor.several) return about
  let above = folderOf(path)
  let folders: Holder[] = []
  for (;;) {
    folders = await folderCopies(accessor, above, path)
    if (folders.length > 0 || !parents || above.vfsPath === '') break
    above = folderOf(above)
  }
  if (folders.length === 0 || folders.some((one) => one.machine === about)) return about
  return chosen(accessor, folders).machine
}

/**
 * The machine a write goes to. What a program's `>` replaces lands on the
 * program's machine, whose disk the program reads next, and a copy made by
 * a read and a write on its source's (`originMachine`). Any other write of
 * a name some machine holds goes to that copy (`chosen`), and a new name
 * goes where its folder is (`newNameMachine`).
 *
 * @param accessor the mount's machines.
 * @param path the name written.
 * @param opts `replaces`: the write replaces the whole file; `parents`: the
 *   folders above a new name are made too.
 * @throws ENOENT when the machine's own links lead the name to one the
 *   session hides.
 */
export async function writeMachine(
  accessor: MachineAccessor,
  path: PathSpec,
  opts: { replaces?: boolean; parents?: boolean } = {},
): Promise<string> {
  const origin = opts.replaces === true ? originMachine(accessor) : null
  if (origin === null) {
    const held = await holders(accessor, path)
    if (held.length > 0) return chosen(accessor, held).machine
  }
  const target = origin ?? (await newNameMachine(accessor, path, opts.parents === true))
  await refuseHidden(accessor, target, path)
  return target
}

/**
 * Where a write of a name lands (`writeMachine`), refusing bytes a program or
 * a copy brings from another machine (`refuseCrossing`). A whole file whose
 * bytes come from the machine it lands on (`originMachine`) replaces the name
 * across the machines, and its folder is made there when only another machine
 * holds it. Mirrors Python's `landing`.
 *
 * @param accessor the mount's machines.
 * @param path the name written.
 * @param opts `replaces`: the write replaces the whole file.
 * @throws EACCES when the bytes come from another machine; ENOENT when the
 *   machine's own links lead the name to one the session hides; ENOTDIR when
 *   the copy shown of the name's folder is a file.
 */
export async function landing(
  accessor: MachineAccessor,
  path: PathSpec,
  opts: { replaces?: boolean } = {},
): Promise<Landing> {
  const replaces = opts.replaces === true
  const machine = await writeMachine(accessor, path, { replaces })
  refuseCrossing(accessor, machine, path)
  if (!replaces || originMachine(accessor) !== machine) return new Landing(machine)
  return new Landing(machine, true, await lacksFolder(accessor, machine, path))
}

/**
 * A copy's landing on the machine its source is on, which the copy never
 * leaves: refused where the machine's own links lead the name to a hidden
 * one, its folder made there when only another machine holds it. Mirrors
 * Python's `landing_on`.
 *
 * @param accessor the mount's machines.
 * @param machine the source's machine.
 * @param path the copy's name.
 * @throws ENOENT when the name leads to a hidden one there; ENOTDIR when the
 *   copy shown of the name's folder is a file.
 */
export async function landingOn(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
): Promise<Landing> {
  await refuseHidden(accessor, machine, path)
  return new Landing(machine, true, await lacksFolder(accessor, machine, path))
}
