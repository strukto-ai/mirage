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

import { CommandSafeguard } from '../../../types.ts'

const DEFAULT_MAX_LINES = 2000
const DEFAULT_TIMEOUT_SECONDS = 600

// Null prototype: command names are script-controlled, so a name like
// `toString` must fall through to the fallback instead of resolving an
// `Object.prototype` member as a safeguard.
export const DEFAULT_COMMAND_SAFEGUARDS: Record<string, CommandSafeguard> = Object.assign(
  Object.create(null) as Record<string, CommandSafeguard>,
  Object.fromEntries(
    ['cat', 'grep', 'rg', 'head', 'tail'].map((name) => [
      name,
      new CommandSafeguard({
        maxLines: DEFAULT_MAX_LINES,
        timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      }),
    ]),
  ),
)

export const FALLBACK_SAFEGUARD = new CommandSafeguard({ timeoutSeconds: DEFAULT_TIMEOUT_SECONDS })

interface SafeguardMount {
  commandSafeguards: Map<string, CommandSafeguard>
}

/**
 * Resolve one command's safeguard, the one entry point.
 *
 * Precedence: an explicit mountOverride, then the command's own
 * default, then aggregation across the mounts the command spans
 * (tightest per field), then the global table.
 */
export function resolveSafeguard(
  name: string,
  mounts: readonly SafeguardMount[] = [],
  commandDefault: CommandSafeguard | null = null,
  mountOverride: CommandSafeguard | null = null,
): CommandSafeguard | null {
  if (mountOverride !== null) return mountOverride
  if (commandDefault !== null) return commandDefault
  if (mounts.length > 0) return resolveAcrossMounts(name, mounts)
  return DEFAULT_COMMAND_SAFEGUARDS[name] ?? FALLBACK_SAFEGUARD
}

export function resolveAcrossMounts(
  name: string,
  mounts: Iterable<SafeguardMount>,
): CommandSafeguard | null {
  const resolved = [...mounts].map((m) =>
    resolveSafeguard(name, [], null, m.commandSafeguards.get(name) ?? null),
  )
  return CommandSafeguard.aggr(resolved)
}
