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

import { askedMachines } from '../../../core/machine/place.ts'
import { statEntry } from '../../../core/machine/stat.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import type { Runtime } from '../../../runtime/base.ts'
import { EXTERNAL_COMMANDS, WHOLE_LINE } from '../../../runtime/constants.ts'
import { RemoteRuntime } from '../../../runtime/machine/runtime.ts'
import type { RouteDecision } from '../../../runtime/types.ts'
import { MachineVFS } from '../../../vfs/machine/machine.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { SessionState } from '../../session/session.ts'
import { envSnapshot } from '../../session/state.ts'
import { lookup, lookupAll } from '../lookup.ts'
import { Consumer } from '../types.ts'
import { mountMachines, pathOnMount } from './mounts.ts'

/**
 * The machines a program no name captures is searched for on, in the order
 * `machines:` lists them. Mirrors Python's `searched_machines`.
 *
 * @param registry the workspace's mounts and machines.
 */
export function searchedMachines(registry: MountRegistry): RemoteRuntime[] {
  return registry.runtimeEntries.filter(
    (entry): entry is RemoteRuntime =>
      entry instanceof RemoteRuntime && entry.captures.includes(EXTERNAL_COMMANDS),
  )
}

/**
 * Whether search order places a program: one a machine runs because no name
 * captures it, on a line that names no machine and no runtime takes whole, in
 * a workspace where several machines take such programs. A machine that
 * refuses the session's runs is asked nothing, so its refusal stays the
 * answer. Mirrors Python's `is_searched`.
 *
 * @param name the program's name.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param routing the line's placement.
 * @param pastFunctions the program a function of the same name shadows is
 *   the one asked about (`which`).
 */
export function isSearched(
  name: string,
  session: SessionState,
  registry: MountRegistry,
  routing: RouteDecision<Runtime> | undefined,
  pastFunctions = false,
): boolean {
  if (routing === undefined || routing.machine !== undefined) return false
  const bindings = routing.bindings
  if (name === '' || name.includes('/')) return false
  if (Object.hasOwn(bindings, name) || Object.hasOwn(bindings, WHOLE_LINE)) return false
  const first = bindings[EXTERNAL_COMMANDS]
  if (!(first instanceof RemoteRuntime) || first.refusesSession()) return false
  if (searchedMachines(registry).length < 2) return false
  if (!pastFunctions) return lookup(name, session, registry, routing) === Consumer.EXTERNAL
  return lookupAll(name, session, registry, routing).every(
    (layer) => layer === Consumer.FUNCTION || layer === Consumer.EXTERNAL,
  )
}

/**
 * Note a machine that could not be asked, which search order then counts
 * out; a run that was killed or timed out stops instead. Mirrors Python's
 * `_unasked`.
 *
 * @param failure what asking threw.
 * @param what what was asked, for the log.
 */
function unasked(failure: unknown, what: string): void {
  if (
    failure instanceof CommandTimeoutError ||
    (failure instanceof Error && failure.name === 'AbortError')
  )
    throw failure
  console.debug(`${what}: not asked, so it decides nothing: ${String(failure)}`)
}

/**
 * The machines holding a path as their own file or folder, by the machine
 * mount showing it; none for a path in a store and for a name no machine
 * holds yet. A machine that cannot be asked counts as not holding it, and
 * the others' answers stand, so a machine that is down neither stops a
 * program nor hides who holds its path.
 *
 * @param path an absolute virtual path.
 * @param registry the workspace's mounts and machines.
 */
async function pathMachines(path: string, registry: MountRegistry): Promise<string[]> {
  const entry = registry.tryMountFor(path)
  if (entry === null || !(entry.vfs instanceof MachineVFS)) return []
  const shown = mountMachines(entry, registry)
  if (shown.length < 2) return shown
  const accessor = entry.vfs.accessor
  const spec = pathOnMount(entry, path)
  let names: string[]
  try {
    names = await askedMachines(accessor, spec)
  } catch (err) {
    unasked(err, path)
    return []
  }
  const found = await Promise.allSettled(names.map((name) => statEntry(accessor, name, spec)))
  const held: string[] = []
  for (const [at, name] of names.entries()) {
    const result = found[at]
    if (result === undefined) continue
    if (result.status === 'fulfilled') {
      held.push(name)
      continue
    }
    const code = (result.reason as { code?: unknown } | null)?.code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') unasked(result.reason, `${name} for ${path}`)
  }
  return held
}

/**
 * The machines a run started now would find a program on (`findsProgram`),
 * in the order given. One that cannot be asked, such as a machine that is
 * down, counts as lacking it. Mirrors Python's `_machines_with`.
 *
 * @param name the program's name.
 * @param path the PATH the run gets; null for each machine's own.
 * @param cwd the folder the run starts in.
 * @param machines the machines to ask.
 */
async function machinesWith(
  name: string,
  path: string | null,
  cwd: string,
  machines: readonly RemoteRuntime[],
): Promise<RemoteRuntime[]> {
  const asked = await Promise.allSettled(
    machines.map((machine) => machine.handle().findsProgram(name, path, cwd)),
  )
  const having: RemoteRuntime[] = []
  for (const [at, machine] of machines.entries()) {
    const found = asked[at]
    if (found === undefined) continue
    if (found.status === 'rejected') unasked(found.reason, `${machine.defaultMachine} for ${name}`)
    else if (found.value) having.push(machine)
  }
  return having
}

/**
 * Of the machines that can run a program, the one search order picks: one
 * the session's folder is on, then one holding the paths the command names,
 * then the first `machines:` lists. Each step narrows the machines left only
 * when it leaves any, so a folder every machine has decides nothing and the
 * paths are asked next.
 *
 * Where a coded file policy speaks for the session no machine is asked about
 * a path, which the policy judges inside the command that opens it: the
 * first machine is the answer. Mirrors Python's `nearest_machine`.
 *
 * @param machines the machines that can run it, in the order `machines:`
 *   lists them.
 * @param cwd the session's folder.
 * @param paths the absolute paths the command names.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 */
export async function nearestMachine(
  machines: readonly string[],
  cwd: string,
  paths: readonly string[],
  session: SessionState,
  registry: MountRegistry,
): Promise<string | null> {
  let left = [...machines]
  if (left.length < 2) return left[0] ?? null
  if (await registry.policies.wantsFor('preVfs', session.sessionId)) return left[0] ?? null
  for (const path of [cwd, ...paths]) {
    if (left.length < 2) break
    const holding = await pathMachines(path, registry)
    const kept = left.filter((machine) => holding.includes(machine))
    if (kept.length > 0) left = kept
  }
  return left[0] ?? null
}

/**
 * The machine a program named by its name runs on when nothing says which
 * (`isSearched`): among the machines a run started now would find the
 * program on (`findsProgram`), the one search order picks
 * (`nearestMachine`). A machine that refuses the session's runs is asked
 * nothing and is no candidate. Null where search order does not place the
 * program, and where no machine has it, so the first machine answers
 * `command not found` as it does today. Mirrors Python's `searched_machine`.
 *
 * @param name the program's name.
 * @param paths the absolute paths the command names.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param routing the line's placement.
 * @param cwd the folder it runs from; null for the session's own.
 * @param path the PATH the command's own prefix sets (`PATH=/opt/bin tool`),
 *   which its run gets; null for the one the session exported.
 * @param pastFunctions the program a function of the same name shadows is
 *   the one asked about (`which`).
 */
export async function searchedMachine(
  name: string,
  paths: readonly string[],
  session: SessionState,
  registry: MountRegistry,
  routing: RouteDecision<Runtime> | undefined,
  cwd: string | null = null,
  path: string | null = null,
  pastFunctions = false,
): Promise<RemoteRuntime | null> {
  if (!isSearched(name, session, registry, routing, pastFunctions)) return null
  const here = cwd ?? session.cwd
  const on = path ?? envSnapshot(session).PATH ?? null
  const willing = searchedMachines(registry).filter((machine) => !machine.refusesSession())
  const having = await machinesWith(name, on, here, willing)
  const picked = await nearestMachine(
    having.map((machine) => machine.defaultMachine),
    here,
    paths,
    session,
    registry,
  )
  return having.find((machine) => machine.defaultMachine === picked) ?? null
}

/**
 * A line's placement with one program bound to the machine search order
 * picked for it, for that program's run alone. Mirrors Python's `bound_to`.
 *
 * @param routing the line's placement.
 * @param name the program's name.
 * @param runtime the machine that runs it.
 */
export function boundTo(
  routing: RouteDecision<Runtime>,
  name: string,
  runtime: RemoteRuntime,
): RouteDecision<Runtime> {
  return { ...routing, bindings: { ...routing.bindings, [name]: runtime } }
}
