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
import { isFsError } from '../../../errors/fs.ts'
import type { ByteSource } from '../../../io/types.ts'
import type { RemoteRuntime } from '../../../runtime/machine/runtime.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { PathSpec } from '../../../types.ts'
import { MachineVFS } from '../../../vfs/machine/machine.ts'
import type { NamespaceReader } from '../../dispatcher/reader.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { SessionState } from '../../session/session.ts'
import { isPiped, machineMounts, onlyMachine, pathOnMount } from './mounts.ts'
import { nearestMachine } from './search.ts'

/**
 * The machine a program named by its path runs on, when the file is one
 * machine's own at that path: the `venv/bin/python` a machine's `python -m
 * venv` made in /tmp runs there, as bash runs it, where Mirage would read the
 * binary and refuse it. A file several machines hold runs on the one the line
 * names when it holds the file, else on the one search order picks among
 * them (`nearestMachine`), and is never read into Mirage. The path is asked
 * of the dispatcher first, so a hidden or refused path stays with Mirage,
 * which words the refusal. Mirrors Python's `program_machine`.
 *
 * @param path the head word, as typed.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param dispatch op dispatcher, which applies the session's hides and
 *   policies to the path.
 * @param stdin what is piped into it.
 * @param named the machine the line names.
 * @param paths the absolute paths the command names.
 * @param cwd the folder it runs from; null for the session's own.
 */
export async function programMachine(
  path: string,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  dispatch: DispatchFn,
  stdin: ByteSource | null,
  named: string | null = null,
  paths: readonly string[] = [],
  cwd: string | null = null,
): Promise<RemoteRuntime | null> {
  const spec = PathSpec.fromStrPath(path, undefined, session.cwd)
  const mounts = machineMounts([[spec.virtual, false]], session, registry, links)
  const entry = mounts?.[0]
  if (entry === undefined || !(entry.vfs instanceof MachineVFS)) return null
  try {
    await dispatch('stat', spec)
  } catch (err) {
    if (!isFsError(err)) throw err
    console.debug(`${path}: not run on its machine: ${String(err)}`)
    return null
  }
  if (await registry.policies.wantsFor('preVfs', session.sessionId)) return null
  const held = (await holders(entry.vfs.accessor, pathOnMount(entry, spec.virtual))).map(
    (one) => one.machine,
  )
  const machine =
    named !== null && held.includes(named)
      ? named
      : await nearestMachine(held, cwd ?? session.cwd, paths, session, registry)
  const runtime = onlyMachine(machine === null ? [] : [machine], registry)
  if (runtime === null) return null
  if (isPiped(stdin) && !runtime.handle().takesInput) return null
  return runtime
}
