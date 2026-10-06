import type { ProcessScope } from '../types.ts'

/**
 * How far past its own session a profile reaches into processes. A session
 * always sees and stops its own processes. `list` widens what `ps` and a
 * handler's process view see; `kill` widens what they may stop, and never
 * past `list`. `max` caps the live processes the session holds, its
 * running line included, as `ulimit -u` counts the shell; null for no cap.
 */
export interface ProcessPermissions {
  readonly list: ProcessScope
  readonly kill: ProcessScope
  readonly max: number | null
}
export const DEFAULT_PROCESS_PERMISSIONS: ProcessPermissions = Object.freeze({
  list: 'session',
  kill: 'session',
  max: null,
})
const SCOPES: readonly ProcessScope[] = ['session', 'workspace']
function parseScope(value: unknown, key: string): ProcessScope {
  if (value !== 'session' && value !== 'workspace')
    throw new Error(`invalid processes.${key} scope`)
  return value
}
/** A profile's `processes`: a bare scope for both, or a mapping of the fields. */
export function parseProcessPermissions(value: unknown): ProcessPermissions {
  if (typeof value === 'string') {
    const scope = parseScope(value, 'list')
    return Object.freeze({ ...DEFAULT_PROCESS_PERMISSIONS, list: scope, kill: scope })
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new Error('processes must be a scope or a mapping')
  const out: { list: ProcessScope; kill: ProcessScope; max: number | null } = {
    ...DEFAULT_PROCESS_PERMISSIONS,
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'max') {
      if (v !== null && !(Number.isInteger(v) && (v as number) >= 1))
        throw new Error('processes.max must be a positive integer')
      out.max = v as number | null
    } else if (key === 'list' || key === 'kill') out[key] = parseScope(v, key)
    else throw new Error(`processes: unknown field ${key}`)
  }
  if (SCOPES.indexOf(out.kill) > SCOPES.indexOf(out.list))
    throw new Error('processes.kill cannot reach past processes.list')
  return Object.freeze(out)
}
export function restrictProcesses(
  a: ProcessPermissions,
  b: ProcessPermissions,
): ProcessPermissions {
  const min = (x: ProcessScope, y: ProcessScope): ProcessScope =>
    SCOPES[Math.min(SCOPES.indexOf(x), SCOPES.indexOf(y))] ?? 'session'
  const caps = [a.max, b.max].filter((cap): cap is number => cap !== null)
  return Object.freeze({
    list: min(a.list, b.list),
    kill: min(a.kill, b.kill),
    max: caps.length === 0 ? null : Math.min(...caps),
  })
}
