import { retainPrograms } from '../../shell/parse/program.ts'
import type { TSNodeLike } from '../../shell/types.ts'

const leases = new WeakMap<Record<string, unknown>, Map<string, () => void>>()
const collected = new FinalizationRegistry<Map<string, () => void>>(releaseEntries)

function releaseEntries(entries: Map<string, () => void>): void {
  for (const release of entries.values()) release()
  entries.clear()
}

/** A function table owns its defining programs independently of the caller. */
export function functionTable(initial: Record<string, unknown> = {}): Record<string, unknown> {
  const entries = new Map<string, () => void>()
  const record = Object.create(null) as Record<string, unknown>
  const table = new Proxy(record, {
    set(target, name, body: unknown): boolean {
      if (typeof name !== 'string') return false
      const release = retainPrograms(Array.isArray(body) ? (body as TSNodeLike[]) : [])
      entries.get(name)?.()
      entries.set(name, release)
      target[name] = body
      return true
    },
    deleteProperty(target, name): boolean {
      if (typeof name !== 'string') return false
      entries.get(name)?.()
      entries.delete(name)
      Reflect.deleteProperty(target, name)
      return true
    },
  })
  leases.set(table, entries)
  collected.register(table, entries, table)
  for (const [name, body] of Object.entries(initial)) table[name] = body
  return table
}

export function releaseFunctions(table: Record<string, unknown>): void {
  for (const name of Object.keys(table)) Reflect.deleteProperty(table, name)
  const entries = leases.get(table)
  if (entries !== undefined) releaseEntries(entries)
  collected.unregister(table)
}
