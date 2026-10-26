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

import { Limit, OnExceed, type Producer } from '../../types.ts'

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

/** The entry naming every command in a limit table. Mirrors Python's ALL_COMMANDS. */
export const ALL_COMMANDS = '*'

interface LimitMount {
  commandLimits: Map<string, Limit>
  defaultLimit: Limit
}

/**
 * A command's own entry in a limit table, or null. Command names are
 * script-controlled, so `toString` must not resolve an `Object.prototype`
 * member of a table built with `{...}`.
 */
export function ownLimit(table: Readonly<Record<string, Limit>>, name: string): Limit | null {
  return Object.hasOwn(table, name) ? (table[name] ?? null) : null
}

function entries(table: Readonly<Record<string, Limit>>, name: string): (Limit | null)[] {
  return [ownLimit(table, name), ownLimit(table, ALL_COMMANDS)]
}

/**
 * Resolve one command's limit, the one precedence engine.
 *
 * Field by field, from the most specific layer that sets it: the profile's
 * entry for the command, then its `*` entry for every command, then the
 * mount's two, the workspace's two, the command's own default, the built-in
 * table and the fallback; on a mount, its backend's default (`walkLimit`)
 * last. A layer that names one bound inherits the rest. A command across
 * several mounts resolves on each and keeps the tightest bound. Mirrors
 * Python's resolve_limit.
 */
export function resolveLimit(
  name: string,
  mounts: readonly LimitMount[] = [],
  commandDefault: Limit | null = null,
  mountOverride: Limit | null = null,
  workspaceLimits: Readonly<Record<string, Limit>> = {},
  profileLimits: Readonly<Record<string, Limit>> = {},
): Limit | null {
  const above = [...entries(profileLimits, name), mountOverride]
  const below = [
    ...entries(workspaceLimits, name),
    commandDefault,
    DEFAULT_COMMAND_LIMITS[name] ?? null,
    FALLBACK_LIMIT,
  ]
  if (mounts.length === 0) return Limit.layered([...above, ...below])
  return Limit.aggr(
    mounts.map((m) =>
      Limit.layered([
        ...above,
        m.commandLimits.get(name) ?? null,
        m.commandLimits.get(ALL_COMMANDS) ?? null,
        ...below,
        m.defaultLimit,
      ]),
    ),
  )
}

export type MountLookup = (prefix: string) => LimitMount | null

/**
 * Resolve producer facts for command output guards and dispatch timeouts,
 * through the same layers as resolveLimit on the mounts its prefixes name.
 * Mirrors Python's resolve_producer.
 */
export function resolveProducer(
  producer: Producer,
  mountAt: MountLookup,
  workspaceLimits: Readonly<Record<string, Limit>> = {},
  profileLimits: Readonly<Record<string, Limit>> = {},
): Limit | null {
  if (producer.command === '') return null
  const mounts = producer.prefixes
    .map((prefix) => mountAt(prefix))
    .filter((m): m is LimitMount => m !== null)
  return resolveLimit(
    producer.command,
    mounts,
    producer.declared,
    null,
    workspaceLimits,
    profileLimits,
  )
}

/** The canonical snake_case command-limit mapping used by config and stored sessions. */
export function parseCommandLimits(raw: unknown): Record<string, Limit> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('command_limits must be a mapping')
  const result: Record<string, Limit> = Object.create(null) as Record<string, Limit>
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`command_limits.${name} must be a mapping`)
    const block = value as Record<string, unknown>
    for (const key of Object.keys(block)) {
      if (!['max_lines', 'max_bytes', 'timeout_seconds', 'walk_limit', 'on_exceed'].includes(key))
        throw new Error(`command_limits.${name}: unknown field ${key}`)
    }
    for (const key of ['max_lines', 'max_bytes', 'timeout_seconds', 'walk_limit']) {
      const v = block[key]
      if (v != null && typeof v !== 'number')
        throw new Error(`command_limits.${name}.${key} must be a number or null`)
    }
    if (
      block.on_exceed !== undefined &&
      block.on_exceed !== OnExceed.ERROR &&
      block.on_exceed !== OnExceed.TRUNCATE
    )
      throw new Error(`command_limits.${name}.on_exceed must be truncate or error`)
    result[name] = new Limit({
      maxLines: (block.max_lines as number | null | undefined) ?? null,
      maxBytes: (block.max_bytes as number | null | undefined) ?? null,
      timeoutSeconds: (block.timeout_seconds as number | null | undefined) ?? null,
      walkLimit: (block.walk_limit as number | null | undefined) ?? null,
      ...(block.on_exceed === undefined ? {} : { onExceed: block.on_exceed }),
    })
  }
  return result
}

/**
 * A limit table as config spells it, each entry with only the fields it
 * sets, so a stored entry still inherits the rest. Mirrors Python's
 * command_limits_to_json.
 */
export function commandLimitsToJSON(
  limits: Readonly<Record<string, Limit>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(limits).map(([name, limit]) => {
      const exceed = limit.chosenOnExceed
      const block: Record<string, unknown> = {
        max_lines: limit.maxLines,
        max_bytes: limit.maxBytes,
        timeout_seconds: limit.timeoutSeconds,
        walk_limit: limit.walkLimit,
        ...(exceed === null ? {} : { on_exceed: exceed }),
      }
      return [name, Object.fromEntries(Object.entries(block).filter(([, v]) => v !== null))]
    }),
  )
}
