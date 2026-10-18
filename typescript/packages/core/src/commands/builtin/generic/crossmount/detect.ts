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
import type { PathSpec } from '../../../../types.ts'
import {
  CROSS_MOUNT_COMMANDS,
  FANOUT_COMMANDS,
  RELAY_COMMANDS,
  STREAM_COMMANDS,
} from './constants.ts'
import { type OperandMount, Strategy } from './types.ts'

// Pick the combine strategy for one cross-mount command invocation.
export function strategyFor(cmdName: string): Strategy {
  if (STREAM_COMMANDS.has(cmdName)) return Strategy.STREAM
  if (FANOUT_COMMANDS.has(cmdName)) return Strategy.FANOUT
  if (RELAY_COMMANDS.has(cmdName)) return Strategy.RELAY
  throw new Error(`Unsupported cross-mount command: ${cmdName}`)
}

/**
 * Whether one invocation spans mounts and runs as a cross-mount one.
 * `operands` are the path operands in line order, each with the mount the
 * workspace resolved for it; `flagScopes` the path-valued flags (`-t`'s
 * directory), which name where a copy lands.
 */
export function isCrossMount(
  cmdName: string,
  operands: readonly OperandMount[],
  flagScopes: readonly PathSpec[] = [],
): boolean {
  if (
    operands.length < 2 ||
    (!CROSS_MOUNT_COMMANDS.has(cmdName) && aggregateFor(cmdName, operands) === null)
  )
    return false
  // a scope outside any mount cannot make the command cross-mount
  const mounts = new Set(operands.flatMap((o) => (o.mount === null ? [] : [o.mount])))
  // A copy of a tree that holds a mount reads both filesystems, the way GNU
  // cp -r copies across one, even from a single mount's operands. Only a
  // source counts: the destination (-t's directory, else the last operand)
  // lands beside a mount and crosses nothing.
  const landing = new Set(
    (flagScopes.length > 0 ? flagScopes : operands.slice(-1).map((o) => o.path)).map(
      (s) => s.virtual,
    ),
  )
  return (
    mounts.size > 1 ||
    (cmdName === 'cp' && operands.some((o) => !landing.has(o.path.virtual) && o.nests))
  )
}

/** Resolve an existing shared reducer; known families own flag-aware reduction. */
export function aggregateFor(
  cmdName: string,
  operands: readonly OperandMount[],
): AggregateFn | null {
  if (CROSS_MOUNT_COMMANDS.has(cmdName)) return null
  let aggregate: AggregateFn | null = null
  for (const operand of operands) {
    if (operand.aggregate === null) return null
    if (aggregate !== null && aggregate !== operand.aggregate) return null
    aggregate = operand.aggregate
  }
  return aggregate
}
