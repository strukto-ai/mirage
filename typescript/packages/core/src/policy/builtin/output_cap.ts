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
import type { Policy } from '../base.ts'
import type { Action, OpsResultContext } from '../types.ts'

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
 * Profile override, mount override, workspace default, command default,
 * then the built-in table. Entries replace whole Limits; absent names
 * inherit. Multiple mounts resolve individually and aggregate tightly.
 */
export function resolveLimit(
  name: string,
  mounts: readonly LimitMount[] = [],
  commandDefault: Limit | null = null,
  mountOverride: Limit | null = null,
  workspaceLimits: Readonly<Record<string, Limit>> = {},
  profileLimits: Readonly<Record<string, Limit>> = {},
): Limit | null {
  if (Object.hasOwn(profileLimits, name)) return profileLimits[name] ?? null
  if (mountOverride !== null) return mountOverride
  if (mounts.length > 0)
    return Limit.aggr(
      mounts.map((m) =>
        resolveLimit(name, [], commandDefault, m.commandLimits.get(name) ?? null, workspaceLimits),
      ),
    )
  if (Object.hasOwn(workspaceLimits, name)) return workspaceLimits[name] ?? null
  if (commandDefault !== null) return commandDefault
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
 * Resolve producer facts for command output guards and dispatch timeouts.
 * Uses the same profile, mount, workspace and command precedence,
 * aggregated to the tightest value across the spanned mounts.
 */
export function resolveProducer(
  producer: Producer,
  overrideFor: OverrideLookup,
  workspaceLimits: Readonly<Record<string, Limit>> = {},
  profileLimits: Readonly<Record<string, Limit>> = {},
): Limit | null {
  if (producer.command === '') return null
  if (producer.prefixes.length === 0) {
    return resolveLimit(
      producer.command,
      [],
      producer.declared,
      null,
      workspaceLimits,
      profileLimits,
    )
  }
  const perMount = producer.prefixes.map((prefix) =>
    resolveLimit(
      producer.command,
      [],
      producer.declared,
      overrideFor(prefix, producer.command),
      workspaceLimits,
      profileLimits,
    ),
  )
  return Limit.aggr(perMount)
}

/**
 * Per-op output bounds, seeded by the registry. Command output uses
 * resolveProducer at its terminal destination; postExecute is reserved
 * for explicit whole-invocation policies.
 */
export class OutputCapPolicy implements Policy {
  private readonly overrideFor: OverrideLookup

  constructor(overrideFor: OverrideLookup) {
    this.overrideFor = overrideFor
  }

  postOps(ctx: OpsResultContext): Action | null {
    return this.overrideFor(ctx.prefix, ctx.op)
  }
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
      if (!['max_lines', 'max_bytes', 'timeout_seconds', 'on_exceed'].includes(key))
        throw new Error(`command_limits.${name}: unknown field ${key}`)
    }
    for (const key of ['max_lines', 'max_bytes', 'timeout_seconds']) {
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
      onExceed: block.on_exceed ?? OnExceed.TRUNCATE,
    })
  }
  return result
}

export function commandLimitsToJSON(
  limits: Readonly<Record<string, Limit>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(limits).map(([name, limit]) => [
      name,
      {
        max_lines: limit.maxLines,
        max_bytes: limit.maxBytes,
        timeout_seconds: limit.timeoutSeconds,
        on_exceed: limit.onExceed,
      },
    ]),
  )
}
