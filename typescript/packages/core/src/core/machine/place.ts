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
import { einval, enoent } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { statRow } from './stat.ts'

/**
 * The machine the running command's program runs on, when it is one of the
 * mount's (`python gen.py > /tmp/out`); null for a command that runs no
 * program on one.
 *
 * @param accessor the mount's machines.
 */
export function stage(accessor: MachineAccessor): string | null {
  const { machine } = currentCaller()
  if (machine === null || !accessor.names().includes(machine.name)) return null
  return machine.name
}

/**
 * The machines that hold a name, asked in parallel; a mount on one machine
 * asks nothing and lets the op itself report a missing name.
 *
 * @param accessor the mount's machines.
 * @param path the name.
 */
export async function holders(accessor: MachineAccessor, path: PathSpec): Promise<string[]> {
  const names = accessor.names()
  if (names.length === 1) return names
  const found = await Promise.allSettled(names.map((m) => statRow(accessor, m, path)))
  const held: string[] = []
  for (const [at, result] of found.entries()) {
    if (result.status === 'fulfilled') {
      held.push(names[at] ?? '')
      continue
    }
    const code = (result.reason as { code?: unknown } | null)?.code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw result.reason
  }
  return held
}

/**
 * The one machine of several holding a name that an op on it goes to: the
 * only one, else the running program's, else none, since picking one would
 * act on a file the command did not mean.
 *
 * @param accessor the mount's machines.
 * @param path the name.
 * @param held the machines holding it.
 */
export function chosen(accessor: MachineAccessor, path: PathSpec, held: string[]): string {
  const [only] = held
  if (held.length === 1 && only !== undefined) return only
  const running = stage(accessor)
  if (running === null || !held.includes(running))
    throw einval(path, `on several machines: ${held.join(', ')}`)
  return running
}

/**
 * The machine a read, a removal or a rename of an existing name goes to.
 *
 * @param accessor the mount's machines.
 * @param path the name.
 * @throws ENOENT when no machine holds it; EINVAL when several do and none
 *   runs the command's program.
 */
export async function holder(accessor: MachineAccessor, path: PathSpec): Promise<string> {
  const held = await holders(accessor, path)
  if (held.length === 0) throw enoent(path)
  return chosen(accessor, path, held)
}

/**
 * The machine a write goes to: the one holding the name, else the running
 * program's, else the mount's default.
 *
 * @param accessor the mount's machines.
 * @param path the name written.
 */
export async function lands(accessor: MachineAccessor, path: PathSpec): Promise<string> {
  const held = await holders(accessor, path)
  if (held.length > 0) return chosen(accessor, path, held)
  return stage(accessor) ?? accessor.defaultMachine
}
