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

import type { MountRegistry } from '../../../../workspace/mount/registry.ts'
import type { PathSpec } from '../../../../types.ts'
import { CROSS_MOUNT_COMMANDS, RELAY_COMMANDS, STREAM_COMMANDS } from './constants.ts'
import { Cmd, Strategy } from './types.ts'

// Pick the combine strategy for one cross-mount command invocation. Flags can
// flip the strategy: `sed -i` edits each operand in place (per-operand
// independent), so it fans out instead of streaming.
export function strategyFor(
  cmdName: Cmd,
  flagKwargs: Record<string, string | boolean | string[]>,
): Strategy {
  if (RELAY_COMMANDS.has(cmdName)) return Strategy.RELAY
  if (cmdName === Cmd.SED && flagKwargs.i === true) return Strategy.FANOUT
  if (STREAM_COMMANDS.has(cmdName)) return Strategy.STREAM
  return Strategy.FANOUT
}

export function isCrossMount(
  cmdName: string,
  scopes: PathSpec[],
  registry: MountRegistry,
): boolean {
  if (!CROSS_MOUNT_COMMANDS.has(cmdName) || scopes.length < 2) return false
  const mounts = new Set<string>()
  for (const s of scopes) {
    const m = registry.mountFor(s.virtual)
    if (m !== null) mounts.add(m.prefix)
  }
  return mounts.size > 1
}
