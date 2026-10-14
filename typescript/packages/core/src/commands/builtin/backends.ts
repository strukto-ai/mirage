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

import type { BaseVFS } from '../../vfs/base.ts'
import { ChromaVFS } from '../../vfs/chroma/chroma.ts'
import { DevVFS } from '../../vfs/dev/dev.ts'
import { DifyVFS } from '../../vfs/dify/dify.ts'
import { HistoryViewVFS } from '../../vfs/history/history.ts'
import { LanceDBVFSBase } from '../../vfs/lancedb/lancedb.ts'
import { Mem0VFS } from '../../vfs/mem0/mem0.ts'
import { QdrantVFS } from '../../vfs/qdrant/qdrant.ts'
import { TrelloVFS } from '../../vfs/trello/trello.ts'
import { Command } from '../config.ts'
import { CHROMA_COMMANDS } from './chroma/index.ts'
import { DEV_COMMANDS } from './dev/index.ts'
import { DIFY_COMMANDS } from './dify/index.ts'
import { HISTORY_COMMANDS } from './history/index.ts'
import { LANCEDB_COMMANDS } from './lancedb/index.ts'
import { MEM0_COMMANDS } from './mem0/index.ts'
import { QDRANT_COMMANDS } from './qdrant/index.ts'
import { TRELLO_COMMANDS } from './trello/index.ts'

// A VFS class, whatever its constructor's visibility (one may build
// through a factory).
interface VFSClass {
  readonly prototype: BaseVFS
}

// The shell commands of each builtin VFS class, kept on the class itself:
// keyed by the class, not its name, so a minified bundle still finds them,
// and under a global symbol, so a VFS extending a class from another copy
// of this package finds that copy's commands, as the BaseVFS brand does. A
// package registers the backends it ships (core's below, node's and the
// browser's from their own `commands/builtin/backends.ts`). Python finds
// the same tables by class path and imports them on first mount.
const BACKENDS = Symbol.for('mirage.backendCommands')

/** Serve `commands` on every mount of `cls` and its subclasses. */
export function registerBackendCommands(cls: VFSClass, commands: () => readonly Command[]): void {
  Object.defineProperty(cls, BACKENDS, { value: commands, configurable: true })
}

// The one VFS name a backend's commands were registered under, or null for
// a set that spans several (the Hugging Face repo kinds share one table).
function familyOf(commands: readonly Command[]): string | null {
  const names = new Set(commands.flatMap((cmd) => (cmd.vfs === null ? [] : [cmd.vfs])))
  const [only] = names
  return names.size === 1 && only !== undefined ? only : null
}

function renamed(cmd: Command, vfs: string): Command {
  return new Command({
    name: cmd.name,
    spec: cmd.spec,
    vfs,
    filetype: cmd.filetype,
    fn: cmd.fn,
    aggregate: cmd.aggregate,
    write: cmd.write,
    pathGuarded: cmd.pathGuarded,
    limit: cmd.limit,
  })
}

/**
 * The shell commands a mount of `vfs` serves beside the generic set.
 *
 * A builtin's are the ones registered for the first class in its hierarchy
 * that has any; a command registered under that backend's one VFS name is
 * registered under the VFS's own instead, so a subclass under its own name
 * serves its base's commands as itself. The commands the VFS was handed
 * come last, so they win. A name none of these has falls back to the
 * generic command every mount shares. Mirrors Python's `commands_for`.
 */
export function commandsFor(vfs: BaseVFS): Command[] {
  let found: Command[] = []
  let cls: unknown = vfs.constructor
  while (typeof cls === 'function') {
    const own: unknown = Object.hasOwn(cls, BACKENDS)
      ? (cls as unknown as Record<symbol, unknown>)[BACKENDS]
      : undefined
    const commands = typeof own === 'function' ? (own as () => readonly Command[])() : undefined
    if (commands !== undefined) {
      const family = familyOf(commands)
      found = commands.map((cmd) =>
        family !== null && cmd.vfs === family && family !== vfs.name ? renamed(cmd, vfs.name) : cmd,
      )
      break
    }
    cls = Object.getPrototypeOf(cls)
  }
  return [...found, ...vfs.commands()]
}

registerBackendCommands(ChromaVFS, () => CHROMA_COMMANDS)
registerBackendCommands(DevVFS, () => DEV_COMMANDS)
registerBackendCommands(DifyVFS, () => DIFY_COMMANDS)
registerBackendCommands(HistoryViewVFS, () => HISTORY_COMMANDS)
registerBackendCommands(LanceDBVFSBase, () => LANCEDB_COMMANDS)
registerBackendCommands(Mem0VFS, () => MEM0_COMMANDS)
registerBackendCommands(QdrantVFS, () => QDRANT_COMMANDS)
registerBackendCommands(TrelloVFS, () => TRELLO_COMMANDS)
