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
import { enotdir } from '../../errors/fs.ts'
import type { FsError } from '../../errors/types.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { PosixEntry } from '../posix/types.ts'
import { chosen, kernelView } from './place.ts'
import { entries, entryStat } from './stat.ts'
import { Holder } from './types.ts'

/**
 * Every machine's entries below one directory as one listing, each name
 * once: the copy every look at the name goes to (`chosen`). A kernel's view
 * of its machine is the one machine's it answers for (`kernelView`), and
 * nothing is listed below a name whose copy shown is a file, whatever an
 * older folder there holds.
 *
 * @param accessor the mount's machines.
 * @param machines the machines listed, in order.
 * @param listed what each printed, the directory's own entry left out.
 * @param scope the directory.
 */
function merged(
  accessor: MachineAccessor,
  machines: string[],
  listed: PosixEntry[][],
  scope: PathSpec,
): Map<string, Holder> {
  const held = new Map<string, Holder[]>()
  for (const [at, found] of listed.entries()) {
    const machine = machines[at] ?? ''
    for (const entry of found) {
      const copies = held.get(entry.rel) ?? []
      copies.push(new Holder(machine, entry))
      held.set(entry.rel, copies)
    }
  }
  const several = machines.length > 1
  const picked = new Map<string, Holder>()
  const over = new Set<string>()
  for (const [rel, all] of held) {
    const own = several ? kernelView(accessor, scope, rel) : null
    const copies = own === null ? all : all.filter((one) => one.machine === own)
    if (copies.length === 0) continue
    const shown = chosen(accessor, copies)
    picked.set(rel, shown)
    if (!shown.folder && copies.some((one) => one.folder)) over.add(rel)
  }
  if (over.size === 0) return picked
  for (const rel of [...picked.keys()]) {
    for (let cut = rel.indexOf('/'); cut !== -1; cut = rel.indexOf('/', cut + 1)) {
      if (!over.has(rel.slice(0, cut))) continue
      picked.delete(rel)
      break
    }
  }
  return picked
}

/**
 * The entry a listed copy was listed with.
 *
 * @param one a copy a listing found.
 */
function listedEntry(one: Holder): PosixEntry {
  if (one.entry === null) throw new Error(`${one.machine}: a listed copy has no entry`)
  return one.entry
}

/**
 * A directory's children on every machine that holds it, each name once,
 * from one find on each machine. A machine that lacks it, or holds a file
 * there or above it, is passed over; any other failure fails the listing,
 * so no machine's files go missing unseen.
 *
 * @param accessor the mount's machines.
 * @param machines the machines to list.
 * @param pathSpec the directory, or a glob in it.
 * @throws ENOTDIR when the copy shown of the directory is a file.
 */
export async function readdir(
  accessor: MachineAccessor,
  machines: string[],
  pathSpec: PathSpec,
): Promise<FileStat[]> {
  const scope = pathSpec.pattern !== null ? pathSpec.dir : pathSpec
  const found = await Promise.allSettled(machines.map((m) => entries(accessor, m, scope, 1)))
  const tops: Holder[] = []
  const listing: string[] = []
  const listed: PosixEntry[][] = []
  let failure: FsError | null = null
  for (const [at, result] of found.entries()) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason
      const code = reason instanceof Error && 'code' in reason ? reason.code : null
      if (code === 'ENOTDIR') {
        failure = reason as FsError
        continue
      }
      if (code !== 'ENOENT') throw reason
      failure ??= reason as FsError
      continue
    }
    const [top, ...below] = result.value
    if (top !== undefined) tops.push(new Holder(machines[at] ?? '', top))
    if (top?.kind !== 'd') {
      failure = enotdir(scope)
      continue
    }
    listing.push(machines[at] ?? '')
    listed.push(below)
  }
  if (listing.length === 0) throw failure ?? enotdir(scope)
  if (!chosen(accessor, tops).folder) throw enotdir(scope)
  return [...merged(accessor, listing, listed, scope)]
    .sort(([a], [b]) => compareCodePoints(a, b))
    .map(([name, one]) => entryStat(name, listedEntry(one)))
}

/**
 * The copy shown of every entry under a directory on the machines that
 * hold it, by its path there, from one find on each; null when a machine's
 * find fails or finds no directory, which leaves the walk to readdir.
 *
 * @param accessor the mount's machines.
 * @param machines the machines holding the directory.
 * @param path the directory.
 */
async function trees(
  accessor: MachineAccessor,
  machines: string[],
  path: PathSpec,
): Promise<Map<string, Holder> | null> {
  const found = await Promise.allSettled(machines.map((m) => entries(accessor, m, path, null)))
  const listed: PosixEntry[][] = []
  for (const result of found) {
    if (result.status === 'rejected') {
      if (!(result.reason instanceof Error) || !('code' in result.reason)) throw result.reason
      console.debug(`${path.virtual}: one find failed; walking it instead:`, result.reason)
      return null
    }
    const [top, ...below] = result.value
    if (top?.kind !== 'd') return null
    listed.push(below)
  }
  return merged(accessor, machines, listed, path)
}

/**
 * Every entry under a directory on the machines that hold it, merged by
 * path as a listing merges them, from one find on each, where a walk sends
 * a listing per directory. A machine whose find fails leaves the walk to
 * readdir, which reports it.
 *
 * @param accessor the mount's machines.
 * @param machines the machines holding the directory.
 * @param path the directory.
 */
export async function tree(
  accessor: MachineAccessor,
  machines: string[],
  path: PathSpec,
): Promise<Map<string, FileStat> | null> {
  const shown = await trees(accessor, machines, path)
  if (shown === null) return null
  const stats = new Map<string, FileStat>()
  for (const [rel, one] of shown)
    stats.set(rel, entryStat(rel.split('/').pop() ?? rel, listedEntry(one)))
  return stats
}

/**
 * The machine whose copy of each entry under a directory is the one shown,
 * by the entry's path there; null as `tree` answers it.
 *
 * @param accessor the mount's machines.
 * @param machines the machines holding the directory.
 * @param path the directory.
 */
export async function treeMachines(
  accessor: MachineAccessor,
  machines: string[],
  path: PathSpec,
): Promise<Map<string, string> | null> {
  const shown = await trees(accessor, machines, path)
  if (shown === null) return null
  return new Map([...shown].map(([rel, one]) => [rel, one.machine]))
}
