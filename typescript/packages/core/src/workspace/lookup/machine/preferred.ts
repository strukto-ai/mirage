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

import { RemoteRuntime } from '../../../runtime/machine/runtime.ts'
import type { Runtime } from '../../../runtime/base.ts'
import type { DispatchFn, RouteDecision } from '../../../runtime/types.ts'
import { PathSpec } from '../../../types.ts'
import { norm } from '../../../utils/path.ts'
import type { PipeWriter } from '../../frame.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { SessionState } from '../../session/session.ts'
import { programHead, programRuntime } from '../lookup.ts'
import { programMachine } from './command.ts'
import { folderMachines, severalMachines } from './mounts.ts'
import { searchedMachine } from './search.ts'

/**
 * The machine a command Mirage runs itself is about
 * (`Caller.preferredMachine`): the one the line names, else the one whose
 * program writes the pipe it reads, else the one its folder is on; null when
 * nothing says, and in a workspace that runs programs on one machine, where
 * nothing is to choose. Mirrors Python's `preferred_machine`.
 *
 * A pipe's writer is placed once for the pipe, so a reader that moves
 * (`gen | (cd /srv; tee log)`) or runs many commands asks no more.
 *
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param routing the line's placement.
 * @param fedBy the program writing the pipe the command reads.
 * @param namespace the link table a writer's path is read through.
 * @param dispatch op dispatcher, which a writer's path is asked of.
 */
export async function preferredMachine(
  session: SessionState,
  registry: MountRegistry,
  routing: RouteDecision<Runtime> | undefined,
  fedBy: PipeWriter | null,
  namespace: Namespace,
  dispatch: DispatchFn,
): Promise<string | null> {
  if (routing === undefined || !severalMachines(registry)) return null
  if (routing.machine !== undefined) return routing.machine
  if (fedBy !== null && !fedBy.placed) {
    fedBy.machine = await writerMachine(fedBy, session, registry, routing, namespace, dispatch)
    fedBy.placed = true
  }
  if (fedBy !== null && fedBy.machine !== null) return fedBy.machine
  const shown = folderMachines(session.cwd, registry)
  const [only] = shown
  return shown.length === 1 && only !== undefined ? only : null
}

/**
 * The machine a pipe's writer runs on, placed as it runs, from the folder
 * its pipeline started in: by its words, through the wrappers Mirage runs
 * (`nice gen | tee log`), and one named by its path on the machine holding
 * that file (`nice /tmp/tool | tee log`). Null for a program Mirage runs
 * itself, and for one that would not start in that folder as far as the
 * mounts tell, which writes nothing: it starts where the folder is `/`, the
 * machine's own, or Mirage's mounts are served into the machine. Mirrors
 * Python's `_writer_machine`.
 *
 * A path is looked up only when no file policy speaks for the session: the
 * lookup asks the dispatcher before the reader is admitted, and a policy
 * judges a call inside the command that makes it.
 *
 * @param fedBy the pipe's writer.
 * @param session the session its reader runs in.
 * @param registry the workspace's mounts and machines.
 * @param routing the line's placement.
 * @param namespace the link table the path is read through.
 * @param dispatch op dispatcher, which the path is asked of.
 */
async function writerMachine(
  fedBy: PipeWriter,
  session: SessionState,
  registry: MountRegistry,
  routing: RouteDecision<Runtime>,
  namespace: Namespace,
  dispatch: DispatchFn,
): Promise<string | null> {
  const head = programHead(registry, fedBy.words, session, routing)
  let runtime: Runtime | null | undefined = null
  if (head.includes('/') && !(await registry.policies.wantsFor('preVfs', session.sessionId)))
    runtime = await programMachine(
      PathSpec.fromStrPath(head, undefined, fedBy.cwd).virtual,
      session,
      registry,
      namespace.sessionLinks(session),
      dispatch,
      null,
      null,
      [],
      fedBy.cwd,
    )
  runtime ??= await searchedMachine(head, [], session, registry, routing, fedBy.cwd)
  runtime ??= programRuntime(registry, fedBy.words, session, routing)
  if (!(runtime instanceof RemoteRuntime)) return null
  const name = runtime.defaultMachine
  if (norm(fedBy.cwd) === '/' || runtime.handle().config.mountType !== undefined) return name
  return folderMachines(fedBy.cwd, registry).includes(name) ? name : null
}
