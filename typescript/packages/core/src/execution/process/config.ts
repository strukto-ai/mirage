import type { ProcessScope } from '../../types.ts'
import { MAX_PROCESSES } from './constants.ts'

/**
 * How far past its own session a profile reaches into processes. A session
 * always sees and stops its own processes. `list` widens what `ps` and a
 * handler's `ctx.processes` see; `kill` widens what they may stop, and never
 * past `list`. `max` caps the live processes the session holds, its
 * running line included, as `ulimit -u` counts the shell; `MAX_PROCESSES`
 * unless stated, null for no cap. The workspace states one for every
 * session and a profile's overrides it field by field (`layerProcesses`).
 */
export interface ProcessPermissions {
  readonly list: ProcessScope
  readonly kill: ProcessScope
  readonly max: number | null
}

/** A `processes` block as written: a bare scope for both, or the fields it states. */
export type ProcessesBlock = ProcessScope | Partial<ProcessPermissions>

export const DEFAULT_PROCESS_PERMISSIONS: ProcessPermissions = Object.freeze({
  list: 'session',
  kill: 'session',
  max: MAX_PROCESSES,
})

const SCOPES: readonly ProcessScope[] = ['session', 'workspace']

function parseScope(value: unknown, key: string): ProcessScope {
  if (value !== 'session' && value !== 'workspace')
    throw new Error(`invalid processes.${key} scope`)
  return value
}

/** The narrower of two scopes. Mirrors Python's `nearer`. */
export function nearer(a: ProcessScope, b: ProcessScope): ProcessScope {
  return SCOPES[Math.min(SCOPES.indexOf(a), SCOPES.indexOf(b))] ?? 'session'
}

/**
 * The fields a `processes` block states, each checked, and `kill` within
 * `list` as the block reads alone, as Python validates one block.
 */
export function statedProcesses(value: unknown): Partial<ProcessPermissions> {
  if (typeof value === 'string') {
    const scope = parseScope(value, 'list')
    return Object.freeze({ list: scope, kill: scope })
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new Error('processes must be a scope or a mapping')
  const out: { list?: ProcessScope; kill?: ProcessScope; max?: number | null } = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'max') {
      if (v !== null && !(Number.isInteger(v) && (v as number) >= 1))
        throw new Error('processes.max must be a positive integer')
      out.max = v as number | null
    } else if (key === 'list' || key === 'kill') out[key] = parseScope(v, key)
    else throw new Error(`processes: unknown field ${key}`)
  }
  if (SCOPES.indexOf(out.kill ?? 'session') > SCOPES.indexOf(out.list ?? 'session'))
    throw new Error('processes.kill cannot reach past processes.list')
  return Object.freeze(out)
}

/**
 * Each field from the first block that states it, else its default, as
 * `Limit.layered` resolves `command_limits`: a profile naming only `max`
 * keeps the workspace's scopes, one naming `max` as null lifts the
 * workspace's cap, and an inherited `kill` never reaches past the `list`
 * above it. Blocks come most specific first. Mirrors Python's
 * `ProcessPermissions.layered`.
 */
export function layerProcesses(
  layers: readonly (ProcessesBlock | null | undefined)[],
): ProcessPermissions {
  const out = { ...DEFAULT_PROCESS_PERMISSIONS }
  for (const layer of [...layers].reverse()) {
    if (layer != null) Object.assign(out, statedProcesses(layer))
  }
  return Object.freeze({ ...out, kill: nearer(out.kill, out.list) })
}

/** A `processes` block on its own, its unstated fields at their defaults. */
export function parseProcessPermissions(value: unknown): ProcessPermissions {
  return layerProcesses([statedProcesses(value)])
}

/**
 * `own` narrowed by the fields an inline document's block states: the
 * nearer scope of each, `kill` never past `list`, the lower cap. Mirrors
 * Python's `ProcessPermissions.restrict`.
 */
export function restrictProcesses(
  own: ProcessPermissions,
  inline: ProcessesBlock,
): ProcessPermissions {
  const stated = statedProcesses(inline)
  const list = stated.list === undefined ? own.list : nearer(own.list, stated.list)
  const kill = stated.kill === undefined ? own.kill : nearer(own.kill, stated.kill)
  const caps = [own.max, stated.max === undefined ? own.max : stated.max].filter(
    (cap): cap is number => cap !== null,
  )
  return Object.freeze({
    list,
    kill: nearer(kill, list),
    max: caps.length === 0 ? null : Math.min(...caps),
  })
}
