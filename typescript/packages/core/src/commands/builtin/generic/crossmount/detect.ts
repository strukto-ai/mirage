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

import type { AggregateFn } from '../../../config.ts'
import type { MountRegistry } from '../../../../workspace/mount/registry.ts'
import type { PathSpec } from '../../../../types.ts'
import {
  CROSS_MOUNT_COMMANDS,
  FANOUT_COMMANDS,
  RELAY_COMMANDS,
  STREAM_COMMANDS,
} from './constants.ts'
import { Strategy } from './types.ts'

// Pick the combine strategy for one cross-mount command invocation.
export function strategyFor(cmdName: string): Strategy {
  if (STREAM_COMMANDS.has(cmdName)) return Strategy.STREAM
  if (FANOUT_COMMANDS.has(cmdName)) return Strategy.FANOUT
  if (RELAY_COMMANDS.has(cmdName)) return Strategy.RELAY
  throw new Error(`Unsupported cross-mount command: ${cmdName}`)
}

export function isCrossMount(
  cmdName: string,
  scopes: PathSpec[],
  registry: MountRegistry,
  flagScopes: readonly PathSpec[] = [],
): boolean {
  if (
    scopes.length < 2 ||
    (!CROSS_MOUNT_COMMANDS.has(cmdName) && aggregateFor(cmdName, scopes, registry) === null)
  )
    return false
  const mounts = new Set<string>()
  for (const s of scopes) {
    // a scope outside any mount cannot make the command cross-mount
    const m = registry.tryMountFor(s.virtual)
    if (m !== null) mounts.add(m.prefix)
  }
  // A copy of a tree that holds a mount reads both filesystems, the way GNU
  // cp -r copies across one, even from a single mount's operands. Only a
  // source counts: the destination (-t's directory, else the last operand)
  // lands beside a mount and crosses nothing.
  const landing = new Set(
    (flagScopes.length > 0 ? flagScopes : scopes.slice(-1)).map((s) => s.virtual),
  )
  return (
    mounts.size > 1 ||
    (cmdName === 'cp' &&
      scopes.some(
        (s) => !landing.has(s.virtual) && registry.descendantMounts(s.virtual).length > 0,
      ))
  )
}

/** Resolve an existing shared reducer; known families own flag-aware reduction. */
export function aggregateFor(
  cmdName: string,
  scopes: readonly PathSpec[],
  registry: MountRegistry,
): AggregateFn | null {
  if (CROSS_MOUNT_COMMANDS.has(cmdName)) return null
  let aggregate: AggregateFn | null = null
  for (const scope of scopes) {
    const handler = registry.tryMountFor(scope.virtual)?.resolveCommand(cmdName)
    if (handler?.aggregate == null) return null
    if (aggregate !== null && aggregate !== handler.aggregate) return null
    aggregate = handler.aggregate
  }
  return aggregate
}
