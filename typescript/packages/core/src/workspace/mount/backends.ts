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
import { DEV_COMMANDS } from '../../commands/builtin/dev/index.ts'

// The shell commands of each builtin VFS class, kept on the class itself:
// keyed by the class, not its name, so a minified bundle still finds them,
// and under a global symbol, so a VFS extending a class from another copy
// of this package finds that copy's commands, as the BaseVFS brand does. A
// package registers the backends it ships, as core does below. Python finds
// the same tables by class path and imports them on first mount.
const BACKENDS = Symbol.for('mirage.backendCommands')

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
      // The one VFS name the commands were registered under; a set that
      // spans several (the Hugging Face repo kinds share one table) has none.
      const families = new Set(commands.flatMap((cmd) => (cmd.vfs === null ? [] : [cmd.vfs])))
      const [family] = families
      return commands.map((cmd) =>
        families.size === 1 && cmd.vfs === family && family !== vfs.name
          ? new Command({
              name: cmd.name,
              spec: cmd.spec,
              vfs: vfs.name,
              filetype: cmd.filetype,
              fn: cmd.fn,
              aggregate: cmd.aggregate,
              write: cmd.write,
              limit: cmd.limit,
            })
          : cmd,
      )
    }
    cls = Object.getPrototypeOf(cls)
  }
  return []
}

Object.defineProperty(DevVFS, BACKENDS, { value: () => DEV_COMMANDS, configurable: true })
