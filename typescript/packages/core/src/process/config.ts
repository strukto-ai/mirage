export type ProcessScope = 'none' | 'session' | 'workspace'
export interface ProcessPermissions {
  readonly metadata: ProcessScope
  readonly details: ProcessScope
  readonly control: ProcessScope
  readonly spawn: boolean
}
export const DEFAULT_PROCESS_PERMISSIONS: ProcessPermissions = Object.freeze({
  metadata: 'session',
  details: 'session',
  control: 'session',
  spawn: true,
})
export function parseProcessPermissions(value: unknown): ProcessPermissions {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new Error('processes must be a mapping')
  const out = { ...DEFAULT_PROCESS_PERMISSIONS }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'spawn') {
      if (typeof v !== 'boolean') throw new Error('processes.spawn must be a boolean')
      out.spawn = v
    } else if (key === 'metadata' || key === 'details' || key === 'control') {
      if (v !== 'none' && v !== 'session' && v !== 'workspace')
        throw new Error(`invalid processes.${key} scope`)
      out[key] = v
    } else throw new Error(`processes: unknown field ${key}`)
  }
  return Object.freeze(out)
}
export function restrictProcesses(
  a: ProcessPermissions,
  b: ProcessPermissions,
): ProcessPermissions {
  const scopes: readonly ProcessScope[] = ['none', 'session', 'workspace']
  const min = (x: ProcessScope, y: ProcessScope): ProcessScope =>
    scopes[Math.min(scopes.indexOf(x), scopes.indexOf(y))] ?? 'none'
  return Object.freeze({
    metadata: min(a.metadata, b.metadata),
    details: min(a.details, b.details),
    control: min(a.control, b.control),
    spawn: a.spawn && b.spawn,
  })
}
