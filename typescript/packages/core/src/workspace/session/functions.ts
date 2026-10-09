import type { Occurrence } from '../../policy/types.ts'

/** Copy portable function definitions without parsing or executing them. */
export function functionSources(value: unknown = {}): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('functions must map names to shell source strings')
  }
  const result = Object.create(null) as Record<string, string>
  for (const [name, source] of Object.entries(value)) {
    if (typeof source !== 'string') {
      throw new TypeError('functions must map names to shell source strings')
    }
    result[name] = source
  }
  return result
}

/**
 * Where a function was defined, for the source it was defined as. The
 * body is parsed again from that source at every call, so its own rows
 * and offsets start at zero; the site puts them back where the
 * definition stood. A site whose source no longer matches the table (a
 * checkout, a stored session) is not the function's. `mark` is the parse
 * and row the body reads aliases at; `origin` the definition's place on
 * its line, which the body's approvals stand under, null outside a line;
 * `aliases` the aliases the body runs, as its definition saw them
 * (`aliasView`), absent or null to read them as they are when it runs.
 * Mirrors Python's FunctionSite.
 */
export interface FunctionSite {
  readonly source: string
  readonly mark: readonly [number, number]
  readonly origin: Occurrence | null
  readonly aliases?: Readonly<Record<string, string>> | null
}
