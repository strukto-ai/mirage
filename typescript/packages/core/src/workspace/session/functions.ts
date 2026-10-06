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
