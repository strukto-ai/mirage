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
import { currentCaller } from '../../context/session_context.ts'
import { enoent, enotdir } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { KERNEL_VIEWS } from './constants.ts'
import { hiddenOn, statEntry } from './stat.ts'
import { Holder } from './types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { folderOf, remote } from './utils.ts'

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
export function kernelView(accessor: MachineAccessor, path: PathSpec, below = ''): string | null {
  if (!accessor.several) return null
  const base = remote(accessor, path)
  const real = below === '' ? base : `${rstripSlash(base)}/${below}`
  if (!KERNEL_VIEWS.some((at) => real === at || real.startsWith(`${at}/`))) return null
  return commandMachine(accessor) ?? accessor.defaultMachine
}

/**
 * The machines asked about a name, in the order `machines:` lists them:
 * every machine of the mount, less each whose own links lead the name to
 * one the session hides, and for a kernel's view of its machine only the
 * one it answers for (`kernelView`).
 *
 * @param accessor the mount's machines.
 * @param path the name.
 */
export async function asked(accessor: MachineAccessor, path: PathSpec): Promise<string[]> {
  const hidden = await hiddenOn(accessor, path)
  const own = kernelView(accessor, path)
  return accessor.names().filter((name) => !hidden.includes(name) && (own === null || own === name))
}

/**
 * The machines that hold a name, each with its entry there, asked in
 * parallel (`asked`); a mount on one machine asks nothing and lets the op
 * itself report a missing name.
 *
 * @param accessor the mount's machines.
 * @param path the name.
 */
export async function holders(accessor: MachineAccessor, path: PathSpec): Promise<Holder[]> {
  const names = await asked(accessor, path)
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
  const last = Math.max(...held.map((one) => one.written))
  const latest = held.filter((one) => one.written === last)
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
export async function holder(accessor: MachineAccessor, path: PathSpec): Promise<string> {
  const held = await holders(accessor, path)
  if (held.length === 0) throw enoent(path)
  return chosen(accessor, held).machine
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
    const held = await holders(accessor, above)
    if (held.length > 0 && !chosen(accessor, held).folder) throw enotdir(path)
    folders = held.filter((one) => one.folder)
    if (folders.length > 0 || !parents || above.vfsPath === '') break
    above = folderOf(above)
  }
  if (folders.length === 0 || folders.some((one) => one.machine === about)) return about
  return chosen(accessor, folders).machine
}

/**
 * The machine a write goes to. What a program's `>` replaces lands on the
 * program's machine, whose disk the program reads next. Any other write of
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
  const running = opts.replaces === true ? runningMachine(accessor) : null
  if (running === null) {
    const held = await holders(accessor, path)
    if (held.length > 0) return chosen(accessor, held).machine
  }
  const target = running ?? (await newNameMachine(accessor, path, opts.parents === true))
  if ((await hiddenOn(accessor, path)).includes(target)) throw enoent(path)
  return target
}
