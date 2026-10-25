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
import { DevVFS } from '../../vfs/dev/dev.ts'
import { Command } from '../../commands/config.ts'
import type { CLI } from '../../commands/cli/types.ts'
import { DEV_COMMANDS } from '../../commands/builtin/dev/index.ts'

// A VFS class, whatever its constructor's visibility (one may build
// through a factory).
interface VFSClass {
  readonly prototype: BaseVFS
}

// The shell commands of each builtin VFS class, kept on the class itself:
// keyed by the class, not its name, so a minified bundle still finds them,
// and under a global symbol, so a VFS extending a class from another copy
// of this package finds that copy's commands, as the BaseVFS brand does. A
// package registers the backends it ships, as core does below. Python finds
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
    limit: cmd.limit,
  })
}

/**
 * The shell commands a builtin backend serves on a mount of `vfs`: mirage's
 * own, beside the generic set.
 *
 * They are the ones registered for the first class in its hierarchy that
 * has any; a command registered under that backend's one VFS name is
 * registered under the VFS's own instead, so a subclass under its own name
 * serves its base's commands as itself. A VFS no builtin backend serves has
 * none. Mirrors Python's `backend_commands`.
 */
export function backendCommands(vfs: BaseVFS): Command[] {
  let cls: unknown = vfs.constructor
  while (typeof cls === 'function') {
    const own: unknown = Object.hasOwn(cls, BACKENDS)
      ? (cls as unknown as Record<symbol, unknown>)[BACKENDS]
      : undefined
    const commands = typeof own === 'function' ? (own as () => readonly Command[])() : undefined
    if (commands !== undefined) {
      const family = familyOf(commands)
      return commands.map((cmd) =>
        family !== null && cmd.vfs === family && family !== vfs.name ? renamed(cmd, vfs.name) : cmd,
      )
    }
    cls = Object.getPrototypeOf(cls)
  }
  return []
}

/**
 * The shell commands a mount of `vfs` serves beside the generic set: a
 * builtin's backend commands first (`backendCommands`), then the commands
 * the VFS was handed, so they win; a command tree it was handed stays a
 * `CLI`, which the mount registers under its root's name. A name none of
 * these has falls back to the generic command every mount shares. Mirrors
 * Python's `commands_for`.
 */
export function commandsFor(vfs: BaseVFS): (Command | CLI)[] {
  return [...backendCommands(vfs), ...vfs.commands()]
}

registerBackendCommands(DevVFS, () => DEV_COMMANDS)
