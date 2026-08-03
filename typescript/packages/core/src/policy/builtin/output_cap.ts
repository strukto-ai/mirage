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

import { Limit, type Producer } from '../../types.ts'
import type { Policy } from '../base.ts'
import type { Action, ExecuteResultContext, OpsResultContext } from '../types.ts'

const DEFAULT_MAX_LINES = 2000
const DEFAULT_TIMEOUT_SECONDS = 600

// Null prototype: command names are script-controlled, so a name like
// `toString` must fall through to the fallback instead of resolving an
// `Object.prototype` member as a limit.
export const DEFAULT_COMMAND_LIMITS: Record<string, Limit> = Object.assign(
  Object.create(null) as Record<string, Limit>,
  Object.fromEntries(
    ['cat', 'grep', 'rg', 'head', 'tail'].map((name) => [
      name,
      new Limit({
        maxLines: DEFAULT_MAX_LINES,
        timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      }),
    ]),
  ),
)

export const FALLBACK_LIMIT = new Limit({ timeoutSeconds: DEFAULT_TIMEOUT_SECONDS })

interface LimitMount {
  commandLimits: Map<string, Limit>
}

/**
 * Resolve one command's limit, the one entry point.
 *
 * Precedence: an explicit mountOverride, then the command's own
 * default, then aggregation across the mounts the command spans
 * (tightest per field), then the global table.
 */
export function resolveLimit(
  name: string,
  mounts: readonly LimitMount[] = [],
  commandDefault: Limit | null = null,
  mountOverride: Limit | null = null,
): Limit | null {
  if (mountOverride !== null) return mountOverride
  if (commandDefault !== null) return commandDefault
  if (mounts.length > 0) return resolveAcrossMounts(name, mounts)
  return DEFAULT_COMMAND_LIMITS[name] ?? FALLBACK_LIMIT
}

export function resolveAcrossMounts(name: string, mounts: Iterable<LimitMount>): Limit | null {
  const resolved = [...mounts].map((m) =>
    resolveLimit(name, [], null, m.commandLimits.get(name) ?? null),
  )
  return Limit.aggr(resolved)
}

export type OverrideLookup = (prefix: string, name: string) => Limit | null

/**
 * Resolve the bound a producer's facts name. Shared by OutputCapPolicy
 * and the dispatch sites that still need the resolved timeout locally:
 * per-prefix override first, then the producer's declared bound, then
 * the global table, aggregated to the tightest value when the command
 * spanned several mounts.
 */
export function resolveProducer(producer: Producer, overrideFor: OverrideLookup): Limit | null {
  if (producer.command === '') return null
  if (producer.prefixes.length === 0) {
    return resolveLimit(producer.command, [], producer.declared)
  }
  const perMount = producer.prefixes.map((prefix) =>
    resolveLimit(producer.command, [], producer.declared, overrideFor(prefix, producer.command)),
  )
  return Limit.aggr(perMount)
}

/**
 * The built-in output cap, seeded by the registry. Answers postExecute
 * with the resolution the `command_limits:` config surface promises
 * (override semantics, see resolveLimit) and postOps with a
 * mount's per-op cap. Config parses into this policy; the container
 * and dispatch know nothing about caps. `overrideFor` maps (mount
 * prefix, command or op name) to that mount's configured override,
 * injected by the registry so this module stays a leaf.
 */
export class OutputCapPolicy implements Policy {
  private readonly overrideFor: OverrideLookup

  constructor(overrideFor: OverrideLookup) {
    this.overrideFor = overrideFor
  }

  postExecute(ctx: ExecuteResultContext): Action | null {
    return resolveProducer(ctx.producer, this.overrideFor)
  }

  postOps(ctx: OpsResultContext): Action | null {
    return this.overrideFor(ctx.prefix, ctx.op)
  }
}
